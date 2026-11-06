;;;; outcome.lisp --- what a compaction's outcome is told as, and who handles one.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/compaction/stats.ts formatCompactionStats, of what
;;;; src/commands/compact-feedback.ts says when a compaction /omp-vcc asked for
;;;; did not happen, and of settings.ts handlesHostCompactions.

(in-package #:omp-vcc)

(defun js-to-fixed-1 (x)
  "Number.prototype.toFixed(1) of the double X: the nearer tenth of its exact value, the larger on a tie."
  (let* ((r (rational (coerce x 'double-float)))
         (n (floor (+ (* r 10) 1/2))))
    (multiple-value-bind (whole tenth) (floor (abs n) 10)
      (format nil "~:[~;-~]~d.~d" (minusp n) whole tenth))))

(defun format-tokens (n)
  (if (>= n 1000) (format nil "~ak" (js-to-fixed-1 (/ (coerce n 'double-float) 1000d0))) (js-string-of n)))

(defun format-compaction-stats (stats)
  "stats.ts formatCompactionStats: the outcome line."
  (let ((cut (json-get stats "budgetCut"))
        (kept (format-tokens (json-get stats "keptTokensEst")))
        (summarized (js-string-of (json-get stats "summarized"))))
    (cond ((equal cut "final_reply") (format nil "omp-vcc: kept the final reply (~~~a tok), summarized ~a." kept summarized))
          ((equal cut "running_turn") (format nil "omp-vcc: kept the running turn's latest steps (~~~a tok), summarized ~a." kept summarized))
          ((truthy-p cut)
           (format nil "omp-vcc: kept ~~~a tok tail (mid-turn cut, ~a), summarized ~a." kept
                   (if (equal cut "no_anchor") "no user anchor" "oversized tail") summarized))
          (t (format nil "omp-vcc: kept ~a/~a turns, ~~~a tok (summarized ~a~a)."
                     (js-string-of (json-get stats "keptUserTurns")) (js-string-of (json-get stats "totalUserTurns")) kept summarized
                     (if (truthy-p (json-get stats "smartKeepAdjusted")) ", smart-keep" ""))))))

(defun compact-error-feedback (input)
  "compact-feedback.ts reportCompactError: (values TEXT SEVERITY), or NIL when nothing is told."
  (let ((message (let ((m (json-get input "message"))) (if (stringp m) m (js-string-of m))))
        (host (json-get input "hostName"))
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
  "settings.ts handlesHostCompactions: unless the user opted out, for every provider or this one."
  (and (eq (json-get settings "overrideDefaultCompaction") :true)
       (not (and (stringp provider)
                 (let ((p (sb-unicode:lowercase provider)))
                   (some (lambda (s) (string= (sb-unicode:lowercase s) p))
                         (coerce (json-get settings "skipForProviders" #()) 'list)))))))
