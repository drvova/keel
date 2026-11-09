;;;; outcome.lisp --- what a compaction's outcome is told as, and who handles one.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The outcome line a compaction is told with, what /keel says when the
;;;; compaction it asked for did not happen (src/compaction.ts
;;;; asks), and whether keel handles the host's compactions at all (the
;;;; user's opt-outs).

(in-package #:keel)

(defun js-to-fixed-1 (x)
  "Number.prototype.toFixed(1) of the double X: the nearer tenth of its exact value, the larger on a tie."
  (let* ((r (rational (coerce x 'double-float)))
         (n (floor (+ (* r 10) 1/2))))
    (multiple-value-bind (whole tenth) (floor (abs n) 10)
      (format nil "~:[~;-~]~d.~d" (minusp n) whole tenth))))

(defun format-tokens (n)
  (if (>= n 1000) (format nil "~ak" (js-to-fixed-1 (/ (coerce n 'double-float) 1000d0))) (js-string-of n)))

(defun format-compaction-stats (stats)
  "The outcome line: what was kept, and how many messages were summarized; then,
for what the user said again this time, that /keel-pin keeps it for good."
  (let ((line (outcome-line stats)) (again (strings-of (json-get stats "saidAgain" #()))))
    ;; One line at most, the newest: a routine request said again is no rule, and a line per one would be noise.
    (if again
        (format nil "~a~%keel: you said \"~a\" more than once~@[ (and ~d more)~]: /~a-pin keeps it in every summary." line
                (js-clip (car (last again)) 120) (and (rest again) (length (rest again))) +command+)
        line)))

(defun outcome-line (stats)
  (let ((cut (json-get stats "budgetCut"))
        (kept (format-tokens (json-get stats "keptTokensEst")))
        (summarized (js-string-of (json-get stats "summarized"))))
    (cond ((equal cut "final_reply") (format nil "keel: kept the final reply (~~~a tok), summarized ~a." kept summarized))
          ((equal cut "running_turn") (format nil "keel: kept the running turn's latest steps (~~~a tok), summarized ~a." kept summarized))
          ((member cut '("no_anchor" "oversized_tail") :test #'equal)
           (format nil "keel: kept ~~~a tok tail (mid-turn cut, ~a), summarized ~a." kept
                   (if (equal cut "no_anchor") "no user anchor" "oversized tail") summarized))
          ((truthy-p cut) (error "No outcome line for the budget cut ~s." cut))
          (t (format nil "keel: kept ~a/~a turns, ~~~a tok (summarized ~a~a)."
                     (js-string-of (json-get stats "keptUserTurns")) (js-string-of (json-get stats "totalUserTurns")) kept summarized
                     (if (truthy-p (json-get stats "smartKeepAdjusted")) ", smart-keep" ""))))))

(defun compact-error-feedback (input)
  "Why a compaction /keel asked for did not happen, from the host's error:
(values TEXT SEVERITY), or NIL when nothing is told. The hook's own cancel notice
was told already; omp's TUI shows its own \"Compaction cancelled\" or
\"Compaction failed\", so there only the hint for a session still too short is added."
  (let ((message (let ((m (json-get input "message"))) (if (stringp m) m (js-string-of m))))
        (host (json-get input "displayName"))
        (compacted (>= (last-compaction-index (coerce (json-get input "branch" #()) 'vector)) 0)))
    (cond ((and (equal (json-get input "mode") "tui") (not (starts-with "Nothing to compact" message))) nil)
          ((and (string= message "Compaction cancelled") (truthy-p (json-get input "cancelNotice"))) nil)
          ((string= message "Already compacted") (values "Nothing to compact: the session was just compacted." "warning"))
          ((string= message "Compaction cancelled") (values "Nothing to compact" "warning"))
          ((starts-with "Nothing to compact" message)
           (values (if compacted
                       (format nil "Nothing to compact yet: what came after the last compaction still fits in the recent part ~a always keeps (compaction.keepRecentTokens in ~a settings). Try again after a few more turns." host host)
                       (format nil "Nothing to compact yet: the whole session still fits in the recent part ~a always keeps (compaction.keepRecentTokens in ~a settings). Try again once the session is longer." host host))
                   "warning"))
          (t (values (format nil "Compaction failed: ~a" message) "error")))))

(defun handles-host-compactions-p (settings provider)
  "Whether keel answers the host's compactions: unless the user opted out
(overrideDefaultCompaction, skipForProviders), for every provider or this one."
  (and (eq (json-get settings "overrideDefaultCompaction") :true)
       (not (and (stringp provider)
                 (let ((p (sb-unicode:lowercase provider)))
                   (some (lambda (s) (string= (sb-unicode:lowercase s) p))
                         (coerce (json-get settings "skipForProviders" #()) 'list)))))))
