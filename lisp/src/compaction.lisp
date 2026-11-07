;;;; compaction.lisp --- what a compaction does: where it cuts, what it writes.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/compaction/plan.ts planCompaction and what it is made of:
;;;; cut.ts (the live window, the cut at a kept user turn, the token-budget
;;;; rescues, a running turn's newest steps, the whole window, smart keep-tail),
;;;; summary-input.ts, assemble.ts (the summary with its history index, pins and
;;;; working set, and the growth guard), token-estimate.ts, history-index.ts,
;;;; and the readers of what an earlier compaction stored (details.ts,
;;;; summary-state.ts readState, pins.ts readPins).
;;;;
;;;; The one thing it cannot do is the host's: convertToLlm. What that makes of
;;;; each live message for the summary (summary-input.ts toSummaryMessage) the TS
;;;; side computes and sends with the entry, of the message as it is (SUMMARY)
;;;; and, where omp rewrote it, as the kept original (RESTORED).

(in-package #:omp-vcc)

;;; --- token estimates (token-estimate.ts) ---------------------------------------

(defparameter +image-content-chars+ 4800)
(defparameter +default-chars-per-token+ 4)

(defun js-json-length (value)
  "The length of JSON.stringify(VALUE ?? \"\")."
  (js-length (json-string (if (or (null value) (eq value :null)) "" value))))

(defun content-chars (content)
  "estimateMessageContentChars: every token-bearing part of a message's content."
  (cond ((stringp content) (js-length content))
        ((not (json-array-p content)) 0)
        (t (loop for part across content
                 sum (if (not (json-object-p part))
                         0
                         (let ((type (json-get part "type")) (text (json-get part "text")))
                           (cond ((equal type "text") (if (stringp text) (js-length text) 0))
                                 ((equal type "thinking") (let ((th (json-get part "thinking"))) (if (stringp th) (js-length th) 0)))
                                 ((equal type "toolCall")
                                  (let* ((a (json-get part "arguments"))
                                         (args (if (or (null a) (eq a :null)) (json-get part "input") a))
                                         (name (json-get part "name")))
                                    (+ (if (stringp name) (js-length name) 0)
                                       (if (stringp args) (js-length args) (js-json-length args)))))
                                 ((equal type "toolResult")
                                  (let ((c (json-get part "content"))) (if (stringp c) (js-length c) (js-json-length c))))
                                 ((equal type "image") +image-content-chars+)
                                 (t (if (stringp text) (js-length text) 0)))))))))

(defun message-chars (m)
  "estimateMessageChars: chars of one message, whatever its shape."
  (if (not (json-object-p m))
      0
      (flet ((len (v) (if (stringp v) (js-length v) 0)))
        (let ((role (json-get m "role")))
          (cond ((equal role "bashExecution") (+ (len (json-get m "command")) (len (json-get m "output"))))
                ((equal role "pythonExecution") (+ (len (json-get m "code")) (len (json-get m "output"))))
                ((member role '("branchSummary" "compactionSummary") :test #'equal) (len (json-get m "summary")))
                ((equal role "fileMention")
                 (let ((files (json-get m "files")))
                   (if (json-array-p files)
                       (loop for f across files
                             sum (+ (len (json-get f "path")) (len (json-get f "content"))
                                    (if (truthy-p (json-get f "image")) +image-content-chars+ 0)))
                       0)))
                (t (content-chars (json-get m "content"))))))))

(defun tokens-from-chars (chars &optional (per-token +default-chars-per-token+))
  "Math.ceil(chars / charsPerToken)."
  (ceiling (/ (coerce chars 'double-float) per-token)))

(defun message-tokens (m per-token) (tokens-from-chars (message-chars m) (or per-token +default-chars-per-token+)))

;;; --- the live window ----------------------------------------------------------------
;;;
;;; An item of the window is (ENTRY LIVE NOTE): the branch entry, its message as
;;; the context holds it, and what the TS side sent of it.

(defun live-message (entry)
  "summary-input.ts toLiveMessage: a branch entry's message in the context, or NIL."
  (let ((type (json-get entry "type")))
    (cond ((and (equal type "message") (truthy-p (json-get entry "message"))) (json-get entry "message"))
          ((equal type "custom_message")
           (json-object "role" "custom" "customType" (json-get entry "customType") "content" (json-get entry "content")))
          ((equal type "branch_summary") (json-object "role" "branchSummary" "summary" (json-get entry "summary")))
          (t nil))))

(defun item-entry (item) (first item))
(defun item-live (item) (second item))
(defun item-note (item) (third item))
(defun item-id (item) (json-get (item-entry item) "id"))
(defun item-role (item) (json-get (item-live item) "role"))

(defun last-index-of-type (branch type &optional stop-at)
  "The index of the last entry of TYPE, -1 for none; with STOP-AT, -1 also when an entry of that type comes after it."
  (loop for i from (1- (length branch)) downto 0
        for ty = (json-get (aref branch i) "type")
        when (equal ty type) return i
        when (and stop-at (equal ty stop-at)) return -1
        finally (return -1)))

(defun last-reset-index (branch) (last-index-of-type branch "reset_boundary"))
(defun last-compaction-index (branch) (last-index-of-type branch "compaction" "reset_boundary"))

(defun live-window-start (branch)
  "cut.ts liveWindowStart: the first entry still in the model's context."
  (let ((reset (last-reset-index branch)) (compaction (last-compaction-index branch)))
    (if (< compaction 0)
        (1+ reset)
        (let ((c (aref branch compaction)))
          (flet ((find-after-reset (id)
                   (if (and (stringp id) (plusp (length id)))
                       (or (loop for i from (1+ reset) below (length branch)
                                 when (equal (json-get (aref branch i) "id") id) return i)
                           -1)
                       -1)))
            (let ((kept (find-after-reset (json-get c "firstKeptEntryId"))))
              (if (>= kept 0)
                  kept
                  (let ((replay (find-after-reset (json-get c "providerReplayThroughEntryId"))))
                    (if (and (>= replay 0) (< replay compaction)) (1+ replay) (1+ compaction))))))))))

(defun live-items (branch notes)
  (loop for i from (live-window-start branch) below (length branch)
        for live = (live-message (aref branch i))
        when live collect (list (aref branch i) live (aref notes i))))

(defun skipped-custom-p (m skip)
  (and (equal (json-get m "role") "custom") (member (json-get m "customType") skip :test #'equal)))

(defun note-summary (note &optional restored)
  "What convertToLlm made of the message for the summary (NIL when nothing): of the kept original with RESTORED."
  (let ((s (if (and restored (nth-value 1 (gethash "restored" note))) (json-get note "restored") (json-get note "summary"))))
    (and (json-object-p s) s)))

(defun renders-p (items skip)
  "summary-input.ts prefixHasRenderableContent: some message of ITEMS adds a block to the summary."
  (some (lambda (item)
          (and (not (skipped-custom-p (item-live item) skip))
               (let ((m (note-summary (item-note item))))
                 (and m (summary-blocks (vector m) nil)))))
        items))

;;; --- cuts -----------------------------------------------------------------------------

(defstruct (cut (:constructor %make-cut)) items first-kept compact-all kept-user-turns total-user-turns fallback budget-cut)

(defun user-turns (items) (count-if (lambda (i) (equal (item-role i) "user")) items))

(defun cut-at (live idx &optional budget-cut)
  (%make-cut :items (subseq live 0 idx) :first-kept (item-id (nth idx live)) :compact-all nil
             :kept-user-turns (user-turns (nthcdr idx live)) :total-user-turns (user-turns live)
             :fallback nil :budget-cut budget-cut))

(defun compact-all-of (live fallback)
  (%make-cut :items live :first-kept "" :compact-all t :kept-user-turns 0 :total-user-turns (user-turns live) :fallback fallback))

(defun build-own-cut (branch notes keep skip)
  "cut.ts buildOwnCut: a cut, or the keyword of why there is none."
  (let ((keep (if (realp keep) (max 0 (floor keep)) 0))
        (live (live-items branch notes)))
    (cond ((null live) :no-live-messages)
          ((<= (length live) 2) :too-few-live-messages)
          ((not (renders-p live skip)) :no-live-messages)
          ((<= keep 0) (compact-all-of live nil))
          (t (let* ((users (loop for item in live for i from 0 when (equal (item-role item) "user") collect i))
                    (target (- (length users) keep))
                    (cut (if (>= target 0) (nth target users) -1)))
               (cond ((<= cut 0) (compact-all-of live t))
                     ((not (renders-p (subseq live 0 cut) skip)) (compact-all-of live t))
                     (t (cut-at live cut))))))))

(defun budget-cut-index (live max-tokens per-token)
  (let ((acc 0) (crossed -1) (v (coerce live 'vector)))
    (loop for i from (1- (length v)) downto 0
          do (incf acc (message-tokens (item-live (aref v i)) per-token))
             (when (>= acc max-tokens) (setf crossed i) (return)))
    (if (< crossed 0)
        -1
        (or (loop for j from (max crossed 1) below (length v)
                  unless (equal (item-role (aref v j)) "toolResult") return j)
            -1))))

(defun running-turn-cut (branch notes max-tokens per-token skip)
  (let* ((live (live-items branch notes))
         (v (coerce live 'vector))
         (tokens (map 'vector (lambda (i) (message-tokens (item-live i) per-token)) v))
         (target (min max-tokens (/ (reduce #'+ tokens) 2)))
         (tail 0) (best -1))
    (loop for i from (1- (length v)) downto 1
          do (incf tail (aref tokens i))
             (when (> tail target) (return))
             (unless (equal (item-role (aref v i)) "toolResult") (setf best i)))
    (if (or (< best 1) (not (renders-p (subseq live 0 best) skip)))
        nil
        (cut-at live best "running_turn"))))

(defun whole-window-cut (branch notes skip)
  (let ((live (live-items branch notes)))
    (if (or (null live) (not (renders-p live skip))) nil (compact-all-of live nil))))

(defun final-answer-p (m)
  (let ((content (json-get m "content")))
    (and (equal (json-get m "role") "assistant") (json-array-p content)
         (some (lambda (p) (and (json-object-p p) (equal (json-get p "type") "text")
                                (stringp (json-get p "text")) (plusp (length (js-trim (json-get p "text"))))))
               content)
         (notany (lambda (p) (and (json-object-p p) (equal (json-get p "type") "toolCall"))) content))))

(defparameter +oversized-tail-factor+ 2.5d0)

(defun apply-tail-budget (branch notes cut max-tokens per-token skip)
  "cut.ts applyTailBudget: the token-budget rescues of a missing or oversized tail."
  (let ((live (live-items branch notes)))
    (flet ((renders (idx) (renders-p (subseq live 0 idx) skip)))
      (if (cut-compact-all cut)
          (if (not (cut-fallback cut))
              cut
              (let ((idx (budget-cut-index live max-tokens per-token)))
                (if (>= idx 0)
                    (if (not (renders idx))
                        cut
                        (cut-at live idx (if (and (= idx (1- (length live))) (final-answer-p (item-live (nth idx live)))) "final_reply" "no_anchor")))
                    (let ((last (1- (length live))))
                      (if (and (> last 0) (final-answer-p (item-live (nth last live))) (renders last))
                          (cut-at live last "final_reply")
                          cut)))))
          (let* ((start (length (cut-items cut)))
                 (tail-tokens (loop for item in (nthcdr start live) sum (message-tokens (item-live item) per-token))))
            (if (<= tail-tokens (* max-tokens +oversized-tail-factor+))
                cut
                (let ((idx (budget-cut-index live max-tokens per-token)))
                  (if (<= idx start) cut (cut-at live idx "oversized_tail")))))))))

(defun kept-chars (entries)
  (loop for e in entries for m = (live-message e) when m sum (message-chars m)))

(defun branch-from (branch id)
  "The entries of BRANCH from the one whose id is ID, or NIL when there is none."
  (let ((at (position id branch :key (lambda (e) (json-get e "id")) :test #'equal)))
    (and at (coerce (subseq branch at) 'list))))

(defun tail-tokens-for-keep (branch notes keep skip per-token)
  (let ((cut (build-own-cut branch notes keep skip)))
    (when (and (cut-p cut) (not (cut-compact-all cut)))
      (let ((kept (position (cut-first-kept cut) branch :key (lambda (e) (json-get e "id")) :test #'equal)))
        (and kept (tokens-from-chars (kept-chars (coerce (subseq branch kept) 'list)) per-token))))))

(defun resolve-smart-keep (branch notes requested smart skip min-tokens max-tokens per-token)
  "cut.ts resolveSmartKeepUserTurns, as (values KEEP ADJUSTED)."
  (let ((base (or requested 1)))
    (if (or requested (not smart))
        (values base nil)
        (let ((base-tokens (tail-tokens-for-keep branch notes base skip per-token)))
          (if (or (null base-tokens) (> base-tokens min-tokens))
              (values base nil)
              (let* ((base-cut (build-own-cut branch notes base skip))
                     (total (if (cut-p base-cut) (cut-total-user-turns base-cut) 0))
                     (selected base))
                (loop for k from (1+ base) to total
                      do (let ((tokens (tail-tokens-for-keep branch notes k skip per-token)))
                           (when (or (null tokens) (> tokens max-tokens)) (return))
                           (setf selected k)))
                (values selected (/= selected base))))))))

;;; --- what an earlier compaction stored -------------------------------------------------

(defun vcc-details-of (details)
  "details.ts vccDetailsOf: omp-vcc's (or pi-vcc's) details on a compaction, or NIL."
  (flet ((own-p (d) (member (json-get d "compactor") '("omp-vcc" "pi-vcc") :test #'equal)))
    (let ((own (if (own-p details) details (json-get details "hookDetails"))))
      (and (own-p own) own))))

(defun read-state (v)
  "summary-state.ts readState: a stored state, as JSON, or NIL when V is none."
  (when (json-object-p v)
    (let ((files (let ((f (json-get v "files" :absent))) (cond ((eq f :absent) (make-hash-table :test 'equal)) ((json-object-p f) f)))))
      (when files
        (labels ((strings-p (x) (and (json-array-p x) (every #'stringp x)))
                 (field (key obj test default)
                   (multiple-value-bind (x present) (gethash key obj)
                     (cond ((not present) (values default t)) ((funcall test x) (values x t)) (t (values nil nil))))))
          (let ((ok t) (out (make-hash-table :test 'equal)) (fout (make-hash-table :test 'equal)))
            (macrolet ((take (key obj test default target)
                         `(multiple-value-bind (x good) (field ,key ,obj ,test ,default)
                            (if good (setf (gethash ,key ,target) x) (setf ok nil)))))
              (take "earlyRequests" v #'strings-p #() out)
              (take "modified" files #'strings-p #() fout)
              (take "created" files #'strings-p #() fout)
              (take "read" files #'strings-p #() fout)
              (take "commits" v (lambda (x) (and (json-array-p x)
                                                 (every (lambda (c) (and (json-object-p c) (stringp (json-get c "message"))
                                                                         (multiple-value-bind (h p) (gethash "hash" c) (or (not p) (stringp h)))))
                                                        x)))
                    #() out)
              (take "tracked" v (lambda (x) (and (json-array-p x)
                                                 (every (lambda (tr) (and (json-object-p tr) (stringp (json-get tr "name")) (strings-p (json-get tr "entries")))) x)))
                    #() out)
              (take "userMessages" v #'strings-p #() out)
              (take "brief" v #'stringp "" out))
            (when ok
              (multiple-value-bind (slots good)
                  (field "earlySlots" v (lambda (x) (and (js-integer-p x) (>= x 0)))
                         (max 0 (- +early-requests-kept+ (length (gethash "earlyRequests" out)))))
                (when good
                  (setf (gethash "earlySlots" out) (as-integer slots)
                        (gethash "files" out) fout)
                  out)))))))))

(defun history-range-p (r)
  (and (json-object-p r)
       (js-integer-p (json-get r "from")) (js-integer-p (json-get r "to")) (<= (json-get r "from") (json-get r "to"))
       (every (lambda (k) (let ((x (json-get r k))) (json-array-p x))) '("asks" "files" "commits"))
       (js-integer-p (json-get r "commitCount")) (js-integer-p (json-get r "failed"))
       (multiple-value-bind (q present) (gethash "requests" r) (or (not present) (js-integer-p q)))))

(defun read-history-index (index)
  "A stored index (details.historyIndex) as a list of ranges, or :INVALID when it is not a well-formed one."
  (if (and (json-array-p index) (every #'history-range-p index)) (coerce index 'list) :invalid))

(defun read-pins (branch)
  "pins.ts readPins: the notes pinned on this branch since its last /clear, by id, as JSON."
  (let ((notes (make-hash-table)))
    (loop for i from (1+ (last-reset-index branch)) below (length branch)
          for e = (aref branch i)
          do (let ((op (json-get e "data")))
               (when (and (equal (json-get e "type") "custom") (equal (json-get e "customType") "omp-vcc.pin") (json-object-p op)
                          (js-integer-p (json-get op "id")))
                 (let ((id (as-integer (json-get op "id"))) (text (json-get op "text")))
                   (cond ((and (equal (json-get op "op") "add") (stringp text) (plusp (length (js-trim text))))
                          (setf (gethash id notes)
                                (json-object "id" id "text" text "by" (if (equal (json-get op "by") "agent") "agent" "user")
                                             "at" (and (js-integer-p (json-get op "at")) (as-integer (json-get op "at"))))))
                         ((equal (json-get op "op") "remove") (remhash id notes)))))))
    (let ((ids (sort (loop for k being the hash-keys of notes collect k) #'<)))
      (mapcar (lambda (id) (gethash id notes)) ids))))

;;; --- [History Index] (history-index.ts) -------------------------------------------------------

(defun longest-first (asks)
  (let ((unique (remove-duplicates asks :test #'string= :from-end t)))
    (let ((sorted (stable-sort (copy-list unique) #'> :key #'js-length)))
      (subseq sorted 0 (min 4 (length sorted))))))

(defun range-of-window (messages indices)
  "The range this compaction summarizes, as JSON, or NIL when it has no #N."
  (let ((known (remove-if-not #'realp (coerce indices 'list))))
    (when known
      (let* ((blocks (summary-blocks messages indices))
             (changed (multiple-value-bind (read modified created) (extract-files blocks nil)
                        (declare (ignore read))
                        (remove-duplicates (append modified created) :test #'string= :from-end t)))
             (commits (mapcar (lambda (c) (js-clip (if (commit-hash c) (format nil "~a ~a" (commit-hash c) (commit-message c)) (commit-message c)) 45))
                              (extract-commits blocks)))
             (asks (extract-user-messages blocks)))
        (json-object "from" (reduce #'min known) "to" (reduce #'max known)
                     "requests" (length asks)
                     "asks" (coerce (mapcar (lambda (a) (js-clip a 80)) (longest-first asks)) 'vector)
                     "files" (coerce (subseq changed 0 (min 24 (length changed))) 'vector)
                     "commits" (coerce (last-n commits 4) 'vector)
                     "commitCount" (length commits)
                     "failed" (count-if (lambda (b) (and (eq (block-kind b) :tool-call) (block-failed b))) blocks))))))

(defun merge-two-ranges (a b)
  (let ((ra (json-get a "requests")) (rb (json-get b "requests")))
    (json-object "from" (min (json-get a "from") (json-get b "from"))
                 "to" (max (json-get a "to") (json-get b "to"))
                 "requests" (and (realp ra) (realp rb) (+ ra rb))
                 "asks" (coerce (longest-first (append (strings-of (json-get a "asks")) (strings-of (json-get b "asks")))) 'vector)
                 "files" (let ((f (remove-duplicates (append (coerce (json-get a "files") 'list) (coerce (json-get b "files") 'list)) :test #'equal :from-end t)))
                           (coerce (subseq f 0 (min 24 (length f))) 'vector))
                 "commits" (coerce (last-n (append (coerce (json-get a "commits") 'list) (coerce (json-get b "commits") 'list)) 4) 'vector)
                 "commitCount" (+ (json-get a "commitCount") (json-get b "commitCount"))
                 "failed" (+ (json-get a "failed") (json-get b "failed")))))

(defun says-nothing-p (r)
  (and (eql (json-get r "requests") 0) (zerop (length (json-get r "files"))) (eql (json-get r "commitCount") 0) (eql (json-get r "failed") 0)))

(defun merge-history-index (previous fresh max-ranges)
  (let* ((ranges (copy-list previous)) (last (car (last ranges))))
    (if (and fresh last (says-nothing-p fresh) (<= (json-get fresh "from") (1+ (json-get last "to"))) (> (json-get fresh "to") (json-get last "to")))
        (let ((extended (copy-object last))) (setf (gethash "to" extended) (json-get fresh "to"))
          (append (butlast ranges) (list extended)))
        (progn
          (when fresh (setf ranges (append ranges (list fresh))))
          (setf ranges (stable-sort ranges #'< :key (lambda (r) (json-get r "from"))))
          (loop while (> (length ranges) (max 2 max-ranges))
                do (let ((best 0) (best-span nil) (v (coerce ranges 'vector)))
                     (loop for i from 0 below (- (length v) 2)
                           for span = (- (json-get (aref v (1+ i)) "to") (json-get (aref v i) "from"))
                           when (or (null best-span) (< span best-span)) do (setf best i best-span span))
                     (setf ranges (append (subseq ranges 0 best) (list (merge-two-ranges (aref v best) (aref v (1+ best)))) (nthcdr (+ best 2) ranges)))))
          ranges))))

(defun unindexed-range (to)
  (json-object "from" 0 "to" to "asks" #() "files" #() "commits" #() "commitCount" 0 "failed" 0))

;;; --- restoring originals for the working set (raw-store.ts restoreOriginals) -----------

(defun restore-originals (messages ids file)
  (if (not (stringp file))
      messages
      (let ((wanted (make-hash-table :test 'equal)))
        (loop for m in messages for id in ids
              when (and (stringp id) (was-rewritten-p m)) do (setf (gethash id wanted) t))
        (if (zerop (hash-table-count wanted))
            messages
            (let ((kept (read-raw-store file wanted)))
              (loop for m in messages for id in ids
                    collect (multiple-value-bind (content found) (if (stringp id) (gethash id kept) (values nil nil))
                              (if found (with-original-content m content) m))))))))

;;; --- the plan (plan.ts planCompaction, assemble.ts assembleSummary) ---------------------------

(defparameter +growth-margin-share+ 0.25d0)

(defun live-roles (items)
  (let ((roles (mapcar #'item-role items)))
    (if (<= (length roles) 30) roles (append (subseq roles 0 10) (list "...") (last roles 10)))))

(defun budget (budgets key) (json-get budgets key))

(defun assemble-summary (branch notes cut input sizing)
  "assemble.ts assembleSummary: (values TEXT STATE SECTIONS SUMMARIZED HISTORY WORKING-SET-SHOWN GROWTH)."
  (let* ((budgets (json-get sizing "budgets"))
         (per-token (json-get (json-get sizing "tokenEstimate") "charsPerToken"))
         (skip (strings-of (json-get (json-get input "settings") "skipCustomTypes")))
         (summarized 0) (messages '()) (indices '()))
    ;; The summary is written from the originals omp-vcc kept (the TS sends what
    ;; convertToLlm makes of them); the cut and the budgets count what the context holds.
    (dolist (item (cut-items cut))
      (unless (skipped-custom-p (item-live item) skip)
        (incf summarized)
        (let ((m (note-summary (item-note item) t)))
          (when m
            (push m messages)
            (push (json-get (item-note item) "n") indices)))))
    (let* ((messages (coerce (nreverse messages) 'vector))
           (indices (coerce (nreverse indices) 'vector))
           (removed (reduce #'+ (mapcar (lambda (i) (message-chars (item-live i))) (cut-items cut))))
           (compaction-at (last-compaction-index branch))
           (previous-compaction (and (>= compaction-at 0) (aref branch compaction-at)))
           (details (and previous-compaction (vcc-details-of (json-get previous-compaction "details"))))
           (window-range (range-of-window messages indices))
           (stored-index (if previous-compaction (read-history-index (json-get details "historyIndex")) '()))
           (history (and window-range
                         (merge-history-index (if (eq stored-index :invalid)
                                                  (if (> (json-get window-range "from") 0) (list (unindexed-range (1- (json-get window-range "from")))) '())
                                                  stored-index)
                                              window-range
                                              (json-get (budget budgets "summary") "historyRanges"))))
           (working-lines nil) (working-shown nil))
      ;; [Working Set], from everything out of context once this lands.
      (when (> (budget budgets "workingSetTokens") 0)
        (let* ((kept-at (if (plusp (length (cut-first-kept cut)))
                            (or (position (cut-first-kept cut) branch :key (lambda (e) (json-get e "id")) :test #'equal) -1)
                            -1))
               (kept (if (>= kept-at 0) (remove nil (map 'list #'live-message (subseq branch kept-at))) '()))
               (past (loop for i from (1+ (last-reset-index branch)) below (if (>= kept-at 0) kept-at (length branch))
                           for m = (live-message (aref branch i))
                           when m collect (list (json-get (aref branch i) "id") m (json-get (aref notes i) "n")))))
          (multiple-value-bind (lines shown)
              (build-working-set (restore-originals (mapcar #'second past) (mapcar #'first past) (json-get input "sessionFile"))
                                 (mapcar #'third past) kept
                                 (* (budget budgets "workingSetTokens") per-token) removed)
            (when lines (setf working-lines lines working-shown shown)))))
      (let* ((task-lines
               ;; [Task State], from everything since /clear: what is summarized, then what stays.
               (let ((since (loop for i from (1+ (last-reset-index branch)) below (length branch)
                                  for m = (live-message (aref branch i))
                                  when m collect (list (json-get (aref branch i) "id") m (json-get (aref notes i) "n")))))
                 (build-task-state (restore-originals (mapcar #'second since) (mapcar #'first since) (json-get input "sessionFile"))
                                   (mapcar #'third since))))
             (previous-summary (let ((p (json-get input "previousSummary"))) (and (stringp p) p)))
             (stored-state (and previous-summary previous-compaction (read-state (json-get details "summaryState"))))
             (summary-input
               (json-object "previous" stored-state
                            "previousSummary" previous-summary
                            "previousSummaryForeign" (if (and previous-compaction (null details)) :true :false)
                            "messages" messages
                            "sourceIndices" indices
                            "historyIndex" (and history (coerce history 'vector))
                            "pinnedNotes" (coerce (read-pins branch) 'vector)
                            "workingSet" (and working-lines (coerce working-lines 'vector))
                            "taskState" (and task-lines (coerce task-lines 'vector))
                            "fileOps" (json-get input "fileOps")
                            "trackCommands" (json-get (json-get input "settings") "trackCommands")
                            "limits" (budget budgets "summary")
                            "ranking" (json-object "maxBriefChars" (js-round (* (budget budgets "briefTokens") per-token))
                                                   "maxBriefCharsCeiling" (js-round (* (budget budgets "briefCeilingTokens") per-token))
                                                   "briefCharsPerBlock" (js-round (* (budget budgets "briefTokensPerBlock") per-token))
                                                   "maxBlocks" (budget budgets "briefMaxBlocks")))))
        (multiple-value-bind (text state sections) (compile-summary summary-input)
          (let* ((net (- (js-length text) (if previous-summary (js-length previous-summary) 0) removed))
                 (allowed (max (budget budgets "growthMarginChars") (js-round (* removed +growth-margin-share+)))))
            (values text state sections summarized history working-shown
                    (json-object "netChars" net "allowedChars" allowed "grows" (if (> net allowed) :true :false)))))))))

(defparameter +cut-notices+
  '((:no-live-messages . "omp-vcc: Nothing to compact (no live messages)")
    (:too-few-live-messages . "omp-vcc: Too few messages to compact")))

(defun cut-reason-name (reason) (if (eq reason :no-live-messages) "no_live_messages" "too_few_live_messages"))

(defun plan-compaction (input)
  "plan.ts planCompaction: what the compaction does, on the branch as the context
holds it (Pi's context edits applied, context-edits.lisp), sized first
(window.lisp), as the plan's JSON."
  (multiple-value-bind (branch notes)
      (apply-context-edits (coerce (json-get input "branch" #()) 'vector) (coerce (json-get input "notes" #()) 'vector))
    (let* ((sizing (size-compaction input branch))
           (plan (plan-sized input branch notes sizing)))
      (when (equal (json-get plan "kind") "compact") (setf (gethash "details" plan) (compaction-details input plan sizing)))
      (setf (gethash "sizing" plan) sizing)
      plan)))

(defun compaction-details (input plan sizing)
  "plan.ts detailsOf: what the compaction entry stores (details.ts): its sections
and state, what it summarized, and what it was sized from."
  (let ((budgets (json-get sizing "budgets")) (window (json-get input "window")))
    (json-object
     "compactor" "omp-vcc"
     ;; version 2 = refs are session-global (recall index space); version 1
     ;; summaries carried window-relative refs (issue #28).
     "version" 2
     "sections" (json-get plan "sections")
     "summaryState" (json-get plan "summaryState")
     "sourceMessageCount" (json-get plan "summarized")
     "previousSummaryUsed" (if (truthy-p (json-get input "previousSummary")) :true :false)
     "reason" (json-get input "reason")
     "willRetry" (json-get input "willRetry")
     "historyIndex" (json-get plan "historyIndex")
     "workingSet" (json-get plan "workingSet")
     "limits" (json-object "contextWindow" (and (truthy-p window) window)
                           "windowSource" (and (truthy-p window) (json-get input "windowSource"))
                           "trigger" (let ((tr (json-get sizing "trigger"))) (and (truthy-p tr) tr))
                           "overheadTokens" (let ((o (json-get sizing "overheadTokens"))) (and (truthy-p o) o))
                           "maxTailTokens" (json-get budgets "maxTailTokens")
                           "briefCeilingTokens" (json-get budgets "briefCeilingTokens")
                           "summaryScale" (let ((sc (json-get budgets "summaryScale"))) (and (not (eql sc 1)) sc))
                           "workingSetTokens" (json-get budgets "workingSetTokens")))))

(defun plan-sized (input branch notes sizing)
  "plan.ts planSized: the plan once SIZING (the policy, trigger, budgets) is known."
  (let* ((settings (json-get input "settings"))
         (skip (strings-of (json-get settings "skipCustomTypes")))
         (budgets (json-get sizing "budgets"))
         (per-token (json-get (json-get sizing "tokenEstimate") "charsPerToken"))
         (requested (let ((k (json-get input "keepUserTurns"))) (and (realp k) k)))
         (recovering (eq (json-get input "recovering") :true))
         (max-tail (budget budgets "maxTailTokens")))
    ;; A pass omp-vcc started itself went by the policy as last recorded; this one
    ;; carries the current policy, which may since say no: compaction off, or a
    ;; trigger the context (measured as the end-of-run check measured it) is under.
    (let ((self (json-get input "selfStarted")))
      (when self
        (let ((used (json-get self "usedTokens")) (trigger (json-get sizing "trigger")))
          (when (or (not (rule-auto-compacts-p (json-get input "ruleName") (json-get sizing "policy")))
                    (and (realp used) trigger (< used trigger)))
            (return-from plan-sized (json-object "kind" "cancel" "why" "policy"))))))
    (multiple-value-bind (keep adjusted)
        (resolve-smart-keep branch notes requested (eq (json-get settings "smartKeepTail") :true) skip
                            (budget budgets "minTailTokens") max-tail per-token)
      (let ((cut (build-own-cut branch notes keep skip)) (running nil))
        (when (and (cut-p cut) (null requested)) (setf cut (apply-tail-budget branch notes cut max-tail per-token skip)))
        (when (and (cut-p cut) (cut-compact-all cut) (cut-fallback cut) (not (eq (json-get input "fromCommand") :true))
                   (equal (item-role (car (last (cut-items cut)))) "toolResult")
                   (not (equal (json-get input "reason") "manual")))
          (unless recovering
            (return-from plan-sized (json-object "kind" "cancel" "why" "running_turn" "summarized" (length (cut-items cut)))))
          (setf cut (or (running-turn-cut branch notes max-tail per-token skip) cut) running t))
        (when (and (not (cut-p cut)) recovering (eq cut :too-few-live-messages))
          (setf cut (or (whole-window-cut branch notes skip) cut)))
        (unless (cut-p cut)
          (let ((roles (coerce (live-roles (live-items branch notes)) 'vector)))
            (return-from plan-sized
              (if recovering
                  (json-object "kind" "step_aside" "cutReason" (cut-reason-name cut) "liveRoles" roles)
                  (json-object "kind" "cancel" "why" "no_cut" "notice" (cdr (assoc cut +cut-notices+))
                               "cutReason" (cut-reason-name cut) "liveRoles" roles)))))
        (multiple-value-bind (text state sections summarized history shown growth) (assemble-summary branch notes cut input sizing)
          (let ((grows (eq (json-get growth "grows") :true)) (n (length (cut-items cut))))
            (when (and grows (or (not recovering) (cut-compact-all cut)))
              (return-from plan-sized
                (json-object "kind" "cancel" "why" "growth"
                             "notice" (cond (recovering (format nil "omp-vcc: Not compacted: the ~d messages left are smaller than a summary of them; the context is full of what no compaction removes (the system prompt and tools)." n))
                                            ((equal (json-get input "reason") "manual")
                                             (format nil "omp-vcc: Not compacted: the summary would be ~d chars larger than the ~d messages it replaces.~a"
                                                     (json-get growth "netChars") n (if (cut-compact-all cut) "" " keep:0 summarizes everything."))))
                             "growth" growth "summarized" n)))
            (let ((kept (and (plusp (length (cut-first-kept cut))) (branch-from branch (cut-first-kept cut)))))
              (json-object "kind" "compact"
                           "summary" text
                           "firstKeptEntryId" (cut-first-kept cut)
                           "sections" (coerce sections 'vector)
                           "summaryState" (state-json state)
                           "summarized" summarized
                           "historyIndex" (and history (coerce history 'vector))
                           "workingSet" (and shown (coerce shown 'vector))
                           "stats" (json-object "summarized" summarized
                                                "keptUserTurns" (cut-kept-user-turns cut)
                                                "totalUserTurns" (cut-total-user-turns cut)
                                                "keptTokensEst" (tokens-from-chars (kept-chars kept) per-token)
                                                "smartKeepAdjusted" (if adjusted :true :false)
                                                "budgetCut" (cut-budget-cut cut))
                           "budgetCut" (cut-budget-cut cut)
                           "compactAll" (if (cut-compact-all cut) :true :false)
                           "writtenForRescue" (and grows (json-object "growth" growth "summarized" n))
                           "runningTurnRecovery" (and running :true)))))))))
