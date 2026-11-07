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

(defun js-date-ms (v)
  "new Date(V).getTime() for the timestamps the hosts write (an ISO string or milliseconds), or NIL."
  (cond ((realp v) v)
        ((stringp v)
         (let ((m (rx-exec (rx "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,3})\\d*)?Z$") v)))
           (when m
             (flet ((g (i) (parse-integer (rx-group m i))))
               (+ (* 1000 (- (encode-universal-time (g 6) (g 5) (g 4) (g 3) (g 2) (g 1) 0) 2208988800))
                  (let ((ms (rx-group m 7))) (if ms (* (parse-integer ms) (expt 10 (- 3 (length ms)))) 0)))))))))

(defun live-message (entry)
  "A branch entry's message in the context, or NIL: a message entry's own; a
custom_message or a branch summary as the host's context builds it, with what
the host's convertToLlm reads of it (an extension's attribution and details)."
  (let ((type (json-get entry "type")))
    (cond ((and (equal type "message") (truthy-p (json-get entry "message"))) (json-get entry "message"))
          ((equal type "custom_message")
           (let ((m (json-object "role" "custom" "customType" (json-get entry "customType") "content" (json-get entry "content")
                                 "display" (json-get entry "display") "details" (json-get entry "details")
                                 "timestamp" (js-date-ms (json-get entry "timestamp")))))
             (multiple-value-bind (a present) (gethash "attribution" entry)
               (when present (setf (gethash "attribution" m) a)))
             m))
          ((equal type "branch_summary")
           (json-object "role" "branchSummary" "summary" (json-get entry "summary") "fromId" (json-get entry "fromId")
                        "timestamp" (js-date-ms (json-get entry "timestamp"))))
          (t nil))))

;;; --- what the host's convertToLlm makes of each message, for the summary ---------

(defun host-converts-p (m)
  "Whether the summary reads M through the host's convertToLlm: omp's developer
turns (host reminders) and @file mentions are host context, not conversation,
and the notice /omp-vcc-pin sends the agent is left out ([Pinned Notes] carries
the note itself)."
  (let ((role (json-get m "role")))
    (not (or (member role '("developer" "fileMention") :test #'equal)
             (and (equal role "custom") (equal (json-get m "customType") +pin-notice-type+))))))

(defun summary-message (m converted)
  "What M becomes in the summary's input, given CONVERTED, what the host's
convertToLlm made of it (a vector, NIL where it was not asked): :NULL for
nothing. A command the user ran (`!cmd`, a python cell) stays as it is: the
brief shows it as one line with its output behind vcc_recall, where
convertToLlm would make it user text. An extension's message, a branch's
summary and user text an extension sent on the agent's behalf are marked
injected, so the early requests, [User Messages] and [History Index] read only
what the user wrote; omp converts a custom message to a developer message, which
is read back as user content."
  (let ((role (json-get m "role")))
    (cond ((or (not (host-converts-p m)) (not (json-array-p converted)) (zerop (length converted))) :null)
          ((member role '("bashExecution" "pythonExecution") :test #'equal) m)
          ((equal role "custom")
           (let ((c (copy-object (aref converted 0)))) (setf (gethash "role" c) "user" (gethash "injected" c) :true) c))
          ((or (equal role "branchSummary") (extension-user-p m))
           (let ((c (copy-object (aref converted 0)))) (setf (gethash "injected" c) :true) c))
          (t (aref converted 0)))))

(defun host-messages (branch file)
  "Each entry's live message on BRANCH and, where omp rewrote it, the original
omp-vcc kept: (values LIVE ORIGINALS), vectors parallel to BRANCH, NIL where none."
  (let* ((live (map 'vector #'live-message branch))
         (at (loop for m across live for i from 0 when m collect i))
         (restored (restore-originals (mapcar (lambda (i) (aref live i)) at)
                                      (mapcar (lambda (i) (json-get (aref branch i) "id")) at) file))
         (originals (make-array (length branch) :initial-element nil)))
    (loop for i in at for r in restored unless (eq r (aref live i)) do (setf (aref originals i) r))
    (values live originals)))

(defun messages-to-convert (live originals)
  "The messages the host is asked to convert, in order: each live one, then its original."
  (loop for m across live for o across originals
        when (and m (host-converts-p m)) collect m
        when (and o (host-converts-p o)) collect o))

(defun host-notes (branch live originals converted index)
  "The note beside each entry: its #N, and what the summary reads of its message,
as it is and as its kept original; CONVERTED is the host's answer for
MESSAGES-TO-CONVERT, in that order."
  (let ((answers (coerce converted 'list)))
    (flet ((summary-of (m) (summary-message m (when (host-converts-p m) (pop answers)))))
      (map 'vector
           (lambda (e m o)
             (let ((note (json-object)))
               (multiple-value-bind (n found) (gethash (json-get e "id") index)
                 (when (and found (stringp (json-get e "id"))) (setf (gethash "n" note) n)))
               (when m (setf (gethash "summary" note) (summary-of m)))
               (when o (setf (gethash "restored" note) (summary-of o)))
               note))
           branch live originals))))

(defun recovery-p (reason will-retry)
  "A pass that must shrink the context: an overflow, a reply cut off at the limit, one the host retries."
  (or (member reason '("overflow" "incomplete") :test #'equal) (eq will-retry :true)))

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

(defun last-reset-index (branch) (last-index-of-type branch +reset-entry-type+))
(defun last-compaction-index (branch) (last-index-of-type branch "compaction" +reset-entry-type+))

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
  (flet ((own-p (d) (member (json-get d "compactor") (list +compactor+ +legacy-compactor+) :test #'equal)))
    (let ((own (if (own-p details) details (json-get details "hookDetails"))))
      (and (own-p own) own))))

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

(defstruct (assembly (:constructor make-assembly (text state sections summarized history shown growth)))
  "A summary written for a cut: its TEXT, the STATE to store and the SECTIONS it
shows; how many messages it SUMMARIZED; the HISTORY ranges to store; the #N
[Working Set] SHOWN; and its GROWTH."
  text state sections summarized history shown growth)

(defstruct (growth (:constructor make-growth (net allowed)))
  "How much a summary adds to the context: NET chars (its length less the previous
summary's and what it removes) against the ALLOWED margin."
  net allowed)

(defun growth-grows-p (g) (> (growth-net g) (growth-allowed g)))
(defun growth-json (g)
  (json-object "netChars" (growth-net g) "allowedChars" (growth-allowed g) "grows" (bool (growth-grows-p g))))

(defun assemble-summary (branch notes cut input sizing)
  "The summary of CUT, with the sections built beside it: an assembly."
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
                                                  (if (> (range-from window-range) 0) (list (unindexed-range (1- (range-from window-range)))) '())
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
               (make-summary-input
                :previous stored-state
                :previous-summary previous-summary
                :previous-foreign (and previous-compaction (null details) t)
                :messages messages
                :indices indices
                :history history
                :pins (read-pins branch)
                :working-set working-lines
                :task-state task-lines
                :file-ops (json-get input "fileOps")
                :track-commands (strings-of (json-get (json-get input "settings") "trackCommands"))
                :limits (budget budgets "summary")
                :ranking (json-object "maxBriefChars" (js-round (* (budget budgets "briefTokens") per-token))
                                      "maxBriefCharsCeiling" (js-round (* (budget budgets "briefCeilingTokens") per-token))
                                      "briefCharsPerBlock" (js-round (* (budget budgets "briefTokensPerBlock") per-token))
                                      "maxBlocks" (budget budgets "briefMaxBlocks")))))
        (multiple-value-bind (text state sections) (compile-summary summary-input)
          (make-assembly text state sections summarized history working-shown
                         (make-growth (- (js-length text) (if previous-summary (js-length previous-summary) 0) removed)
                                      (max (budget budgets "growthMarginChars") (js-round (* removed +growth-margin-share+))))))))))

(defparameter +cut-notices+
  '((:no-live-messages . "omp-vcc: Nothing to compact (no live messages)")
    (:too-few-live-messages . "omp-vcc: Too few messages to compact")))

(defun cut-reason-name (reason) (if (eq reason :no-live-messages) "no_live_messages" "too_few_live_messages"))

(defun plan-compaction (input branch notes)
  "What the compaction does, on BRANCH as the context holds it (Pi's context
edits applied) with NOTES beside its entries (host-notes), sized first
(window.lisp), as the plan's JSON."
  (let* ((sizing (size-compaction input branch))
         (plan (plan-sized input branch notes sizing)))
    (when (equal (json-get plan "kind") "compact") (setf (gethash "details" plan) (compaction-details input plan sizing)))
    (setf (gethash "sizing" plan) sizing)
    plan))

(defun compaction-details (input plan sizing)
  "plan.ts detailsOf: what the compaction entry stores (details.ts): its sections
and state, what it summarized, and what it was sized from."
  (let ((budgets (json-get sizing "budgets")) (window (json-get input "window")))
    (json-object
     "compactor" +compactor+
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
        (let* ((a (assemble-summary branch notes cut input sizing))
               (growth (assembly-growth a)) (grows (growth-grows-p growth)) (n (length (cut-items cut))))
            (when (and grows (or (not recovering) (cut-compact-all cut)))
              (return-from plan-sized
                (json-object "kind" "cancel" "why" "growth"
                             "notice" (cond (recovering (format nil "omp-vcc: Not compacted: the ~d messages left are smaller than a summary of them; the context is full of what no compaction removes (the system prompt and tools)." n))
                                            ((equal (json-get input "reason") "manual")
                                             (format nil "omp-vcc: Not compacted: the summary would be ~d chars larger than the ~d messages it replaces.~a"
                                                     (growth-net growth) n (if (cut-compact-all cut) "" " keep:0 summarizes everything."))))
                             "growth" (growth-json growth) "summarized" n)))
            (let ((kept (and (plusp (length (cut-first-kept cut))) (branch-from branch (cut-first-kept cut)))))
              (json-object "kind" "compact"
                           "summary" (assembly-text a)
                           "firstKeptEntryId" (cut-first-kept cut)
                           "sections" (coerce (assembly-sections a) 'vector)
                           "summaryState" (state-json (assembly-state a))
                           "summarized" (assembly-summarized a)
                           "historyIndex" (and (assembly-history a) (map 'vector #'range-json (assembly-history a)))
                           "workingSet" (and (assembly-shown a) (coerce (assembly-shown a) 'vector))
                           "stats" (json-object "summarized" (assembly-summarized a)
                                                "keptUserTurns" (cut-kept-user-turns cut)
                                                "totalUserTurns" (cut-total-user-turns cut)
                                                "keptTokensEst" (tokens-from-chars (kept-chars kept) per-token)
                                                "smartKeepAdjusted" (if adjusted :true :false)
                                                "budgetCut" (cut-budget-cut cut))
                           "budgetCut" (cut-budget-cut cut)
                           "compactAll" (if (cut-compact-all cut) :true :false)
                           "writtenForRescue" (and grows (json-object "growth" (growth-json growth) "summarized" n))
                           "runningTurnRecovery" (and running :true))))))))
