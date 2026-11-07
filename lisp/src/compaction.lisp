;;;; compaction.lisp --- what a compaction does: where it cuts, what it writes.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The plan of a compaction (op compact): the token estimates, the live
;;;; window, where it cuts (smart keep-tail, the cut at a kept user turn, the
;;;; token-budget rescues, a running turn's newest steps, the whole window),
;;;; what it writes (the summary with [History Index], [Pinned Notes],
;;;; [Working Set] and [Task State]), whether that is worth writing (the growth
;;;; guard), and what the compaction entry stores; with the readers of what an
;;;; earlier compaction stored.
;;;;
;;;; The one thing it cannot do is the host's: convertToLlm. The hook
;;;; (src/hooks/compaction.ts) converts the messages MESSAGES-TO-CONVERT lists
;;;; and sends the answers back; HOST-NOTES puts them beside each entry, of the
;;;; message as it is (SUMMARY) and, where omp rewrote it, as the kept original
;;;; (RESTORED).

(in-package #:omp-vcc)

;;; --- token estimates ---------------------------------------------------------------

(defparameter +image-content-chars+ 4800)
(defparameter +default-chars-per-token+ 4)

(defun js-json-length (value)
  "The length of JSON.stringify(VALUE ?? \"\")."
  (js-length (json-string (if (or (null value) (eq value :null)) "" value))))

(defun content-chars (content)
  "The chars of every token-bearing part of a message's content."
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
  "The chars of one message, whatever its shape."
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
;;; the context holds it, and its note from HOST-NOTES.

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
             (and (equal role "custom") (member (json-get m "customType") (list +pin-notice-type+ +budget-notice-type+) :test #'equal))))))

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
               (when o (setf (gethash "restored" note) (summary-of o) (gethash "original" note) o))
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
  "The index of the first branch entry still in the model's context.
With no compaction, the whole branch (after omp's /clear). After one, its
firstKeptEntryId; when that is \"\" (a compact-all's sentinel) or no longer on
the branch, right after the compaction, or right after an omp native-replay
compaction's providerReplayThroughEntryId, where omp's own kept tail starts. A
reset_boundary (omp's /clear) after the latest compaction starts the window
after it, and one before it bounds where the kept id is looked for, as omp's
prepareCompaction does."
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
  "Some message of ITEMS adds a block to the summary. A window or prefix that
renders none would store an empty summary while keeping everything: the context
never shrinks and the next pass triggers again."
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

;; The whole live window summarized. firstKeptEntryId "" matches no entry in
;; the host's buildSessionContext (nothing kept from before the compaction), and
;; the next cut starts after the compaction entry (LIVE-WINDOW-START). FALLBACK:
;; compact-all because keep:N found no boundary, not because keep:0 asked for
;; it, so a tail budget may still keep some.
(defun compact-all-of (live fallback)
  (%make-cut :items live :first-kept "" :compact-all t :kept-user-turns 0 :total-user-turns (user-turns live) :fallback fallback))

(defun build-own-cut (branch notes keep skip)
  "The cut that keeps the last KEEP user turns, or the keyword of why there is
none. When KEEP finds no safe boundary (one user prompt, none, or more asked
than there are), or the prefix before it renders nothing (a lone system entry
or a skipped custom message before the first user message), everything is
summarized and APPLY-TAIL-BUDGET decides the tail."
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

;; The token-budget cut that rescues a default-path tail when the user-turn
;; anchored one is absent (an autonomous run: no user turn in the live window)
;; or oversized (one giant last user turn): where the newest MAX-TOKENS start,
;; snapped forward off any tool result, like omp's own cut point.
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
  "A recovery pass (an overflow, a cut-off reply) on a turn still running whose
live window has no earlier user turn: something must shrink, and summarizing the
whole turn takes away the tool output the agent is working from. Keeps the
turn's newest steps, at most half the window and MAX-TOKENS, and summarizes the
request and the steps before them (their originals stay in recall). NIL when no
boundary leaves that. What is kept and still too big, omp's own rescue trims
after the compaction commits (it shakes oversized tool output)."
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
  "One or two live messages, summarized whole: on a recovery pass something must
shrink, and a request or reply far too big for the window (a long paste, one huge
result) shrinks to its summary line, its original in recall."
  (let ((live (live-items branch notes)))
    (if (or (null live) (not (renders-p live skip))) nil (compact-all-of live nil))))

(defun final-answer-p (m)
  "An assistant message that ends a turn: text, and no tool call waiting for its result."
  (let ((content (json-get m "content")))
    (and (equal (json-get m "role") "assistant") (json-array-p content)
         (some (lambda (p) (and (json-object-p p) (equal (json-get p "type") "text")
                                (stringp (json-get p "text")) (plusp (length (js-trim (json-get p "text"))))))
               content)
         (notany (lambda (p) (and (json-object-p p) (equal (json-get p "type") "toolCall"))) content))))

(defparameter +oversized-tail-factor+ 2.5d0
  "A kept user-turn tail over this many times the tail budget is cut inside.")

(defun apply-tail-budget (branch notes cut max-tokens per-token skip)
  "The token-budget rescues of a missing or oversized tail, on the default path
only (an explicit keep:N is respected absolutely, keep:0 included). A compact-all
for want of a boundary is cut at the budget instead; a cut that keeps only the
turn's final answer is a finished turn's reply (final_reply). When the whole
window fits the budget and ends with that answer, the answer is kept: compact-all
would take the reply out of context too, and omp's print mode, which prints the
last assistant message, would then have nothing. A kept user-turn tail over
+OVERSIZED-TAIL-FACTOR+ times the budget is cut inside (oversized_tail)."
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
  "Chars of what stays in context of ENTRIES: every live message, custom messages and branch summaries included."
  (loop for e in entries for m = (live-message e) when m sum (message-chars m)))

(defun branch-from (branch id)
  "The entries of BRANCH from the one whose id is ID, or NIL when there is none."
  (let ((at (position id branch :key (lambda (e) (json-get e "id")) :test #'equal)))
    (and at (coerce (subseq branch at) 'list))))

(defun tail-tokens-for-keep (branch notes keep skip per-token)
  "The kept tail's tokens under keep:KEEP; NIL when that cuts nothing or summarizes
everything, so smart keep-tail stops growing instead of losing the tail."
  (let ((cut (build-own-cut branch notes keep skip)))
    (when (and (cut-p cut) (not (cut-compact-all cut)))
      (let ((kept (position (cut-first-kept cut) branch :key (lambda (e) (json-get e "id")) :test #'equal)))
        (and kept (tokens-from-chars (kept-chars (coerce (subseq branch kept) 'list)) per-token))))))

(defun resolve-smart-keep (branch notes requested smart skip min-tokens max-tokens per-token)
  "The effective keep:N, as (values KEEP ADJUSTED). The user's keep:N is always
respected; without SMART it is 1; with it, when keep:1's tail is at most
MIN-TOKENS, the largest N whose tail stays within MAX-TOKENS, stopping where a
cut would summarize everything."
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
  "omp-vcc's (or pi-vcc's) details on a compaction, also under omp's rollover (hookDetails), or NIL."
  (flet ((own-p (d) (member (json-get d "compactor") (list +compactor+ +legacy-compactor+) :test #'equal)))
    (let ((own (if (own-p details) details (json-get details "hookDetails"))))
      (and (own-p own) own))))

;;; --- restoring the originals omp-vcc kept ------------------------------------------------

;;; --- the plan --------------------------------------------------------------------------------

(defparameter +growth-margin-share+ 0.25d0
  "Growth a summary may add before it is not worth writing: its framing (the
budgets' growthMarginChars), or this share of what it replaces.")

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
summary's and what it removes; the kept tail is the same either way) against the
ALLOWED margin. A short prefix (two messages after omp's plan-mode \"approve and
compact\", a session barely past a low threshold) can be smaller than the
sections and brief that would replace it."
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
    ;; omp may have blanked or shaken some of these in place since they landed.
    ;; The summary is all that will remain of them, so it is written from the
    ;; originals omp-vcc kept (the hook sends what convertToLlm makes of them);
    ;; the cut and the budgets count what the context holds now.
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
           (working-lines nil) (working-shown nil)
           ;; Every message since /clear, as the original omp-vcc kept where omp rewrote it: (BRANCH-POS MESSAGE #N).
           (since (loop for i from (1+ (last-reset-index branch)) below (length branch)
                        for m = (live-message (aref branch i))
                        when m collect (list i (or (json-get (aref notes i) "original") m) (json-get (aref notes i) "n")))))
      ;; [Working Set], from everything out of context once this lands since /clear
      ;; (what this compaction summarizes and what earlier ones did), so the agent
      ;; does not spend its next requests fetching it again. The budgets give it
      ;; no room when the setting is off.
      (when (> (budget budgets "workingSetTokens") 0)
        (let* ((kept-at (if (plusp (length (cut-first-kept cut)))
                            (or (position (cut-first-kept cut) branch :key (lambda (e) (json-get e "id")) :test #'equal) -1)
                            -1))
               (kept (if (>= kept-at 0) (remove nil (map 'list #'live-message (subseq branch kept-at))) '()))
               (past (remove-if (lambda (s) (and (>= kept-at 0) (>= (first s) kept-at))) since)))
          (multiple-value-bind (lines shown)
              (build-working-set (mapcar #'second past) (mapcar #'third past) kept
                                 (* (budget budgets "workingSetTokens") per-token) removed)
            (when lines (setf working-lines lines working-shown shown)))))
      (let* ((task-lines
               ;; [Task State], from everything since /clear: what is summarized, then what stays.
               (build-task-state (mapcar #'second since) (mapcar #'third since)))
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

(defparameter +cut-reasons+
  '((:no-live-messages "no_live_messages" "omp-vcc: Nothing to compact (no live messages)")
    (:too-few-live-messages "too_few_live_messages" "omp-vcc: Too few messages to compact"))
  "Why there is no cut: (REASON NAME NOTICE).")

(defun cut-reason-name (reason) (second (assoc reason +cut-reasons+)))
(defun cut-reason-notice (reason) (third (assoc reason +cut-reasons+)))

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
  "What the compaction entry stores: its sections and state, what it summarized,
and what it was sized from (for debugging a compaction that kept too much or too little)."
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
  "The plan once SIZING (the policy, trigger, budgets) is known."
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
    ;; With turns leaving the context whole (the evict setting, evict.lisp), the
    ;; host's automatic threshold and idle passes would write a summary over what
    ;; eviction keeps whole: they are turned down while a finished turn is left
    ;; to take out, and the next request makes room. With none left (all out
    ;; already, or the running turn alone fills the window) the summary runs, so
    ;; the context never grows on until a request overflows. A recovery still
    ;; gets its summary, and so does a compaction the user asked for.
    (when (and (eq (json-get settings "evict") :true) (not recovering) (not (eq (json-get input "fromCommand") :true))
               (member (json-get input "reason") '("threshold" "idle") :test #'equal)
               (eq (json-get input "evictRoom") :true))
      (return-from plan-sized (json-object "kind" "cancel" "why" "evict")))
    (multiple-value-bind (keep adjusted)
        (resolve-smart-keep branch notes requested (eq (json-get settings "smartKeepTail") :true) skip
                            (budget budgets "minTailTokens") max-tail per-token)
      (let ((cut (build-own-cut branch notes keep skip)))
        (when (and (cut-p cut) (null requested)) (setf cut (apply-tail-budget branch notes cut max-tail per-token skip)))
        ;; An automatic pass on a turn still running (its last message is a tool
        ;; result: omp compacts between the tool calls of one turn) whose live
        ;; window has no earlier user turn and fits the tail budget: the only cut
        ;; left is compact-all, which would summarize away the request and tool
        ;; output the agent is working from. A threshold or idle pass waits until
        ;; the turn has ended; a recovery pass keeps the turn's newest steps.
        (when (and (cut-p cut) (cut-compact-all cut) (cut-fallback cut) (not (eq (json-get input "fromCommand") :true))
                   (equal (item-role (car (last (cut-items cut)))) "toolResult")
                   (not (equal (json-get input "reason") "manual")))
          (unless recovering
            (return-from plan-sized (json-object "kind" "cancel" "why" "running_turn" "summarized" (length (cut-items cut)))))
          (setf cut (or (running-turn-cut branch notes max-tail per-token skip) cut)))
        ;; One or two messages too big for the window: summarized whole on a recovery
        ;; pass. Nothing live to summarize: no method of the host's can shrink it
        ;; either, so a recovery pass is left to it.
        (when (and (not (cut-p cut)) recovering (eq cut :too-few-live-messages))
          (setf cut (or (whole-window-cut branch notes skip) cut)))
        (unless (cut-p cut)
          (let ((roles (coerce (live-roles (live-items branch notes)) 'vector)))
            (return-from plan-sized
              (if recovering
                  (json-object "kind" "step_aside" "cutReason" (cut-reason-name cut) "liveRoles" roles)
                  (json-object "kind" "cancel" "why" "no_cut" "notice" (cut-reason-notice cut)
                               "cutReason" (cut-reason-name cut) "liveRoles" roles)))))
        (let* ((a (assemble-summary branch notes cut input sizing))
               (growth (assembly-growth a)) (grows (growth-grows-p growth)) (n (length (cut-items cut))))
            ;; Growth guard: a compaction that leaves the context bigger is not
            ;; written, and a manual pass says why (an automatic one would say so on
            ;; every turn until the prefix grows). Recovering, it is written when it
            ;; keeps part of the window: what overflows is that kept part, and omp's
            ;; rescue shakes its oversized tool output once this commits. When even
            ;; summarizing the whole window grows the context, what fills it is what
            ;; no compaction removes.
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
                           ;; A recovery writes a summary that grows when it keeps part of the window.
                           "growth" (growth-json growth))))))))
