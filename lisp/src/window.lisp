;;;; window.lisp --- where the host compacts next, and the budgets that land below it.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/window.ts (the limit an overflow error states, each
;;;; host's trigger from the policy it hands the hook, the budgets that follow
;;;; the trigger) and of the context measure plan.ts sizes a compaction from
;;;; (token-estimate.ts calibrateCharsPerToken). The learned-limits file and the
;;;; effective window stay in TypeScript (model-limits.ts): they are file IO.
;;;;
;;;; JavaScript does this arithmetic on doubles, so it is done on doubles here,
;;;; in the order the TS writes it; a division never makes a ratio.

(in-package #:omp-vcc)

(defun dbl (x) (coerce x 'double-float))

(defun positive-floor (v)
  "window.ts positive: Math.floor of a finite number over 0, else NIL."
  (and (realp v) (> v 0) (floor v)))

(defun clamp-tokens (value floor ceiling)
  (js-round (max floor (min ceiling value))))

;;; --- overflow errors ----------------------------------------------------------------

(defparameter +limit-patterns+
  (list (rx "maximum context length is (\\d[\\d,]*) tokens" "i")
        (rx "context length of only (\\d[\\d,]*) tokens" "i")
        (rx "prompt is too long: \\d[\\d,]* tokens > (\\d[\\d,]*) maximum" "i")
        (rx "maximum prompt length is (\\d[\\d,]*)" "i")
        (rx "exceeds the maximum number of tokens allowed \\((\\d[\\d,]*)\\)" "i")
        (rx "exceeds the context window of (\\d[\\d,]*)" "i")
        (rx "exceeds the (?:context|token) limit of (\\d[\\d,]*)" "i")
        (rx "exceeds the limit of (\\d[\\d,]*) tokens" "i")
        (rx "exceeds the context \\((\\d[\\d,]*)\\)" "i")
        (rx "in the context \\((\\d[\\d,]*)\\)" "i")
        (rx "available context size \\((\\d[\\d,]*) tokens\\)" "i")
        (rx "\\bn_ctx[^\\d]{0,12}(\\d[\\d,]*)" "i")
        (rx "context (?:window|length|size) (?:is|of) (\\d[\\d,]*)" "i")
        (rx "greater than the context length of (\\d[\\d,]*)" "i")))

(defun limit-from-overflow-error (text)
  "window.ts limitFromOverflowError: the context limit an overflow error states, or NIL."
  (when (and (stringp text) (plusp (length text)))
    (dolist (re +limit-patterns+)
      (let* ((m (rx-exec re text))
             ;; Number() of the digits with the commas taken out: a run of digits
             ;; past a double's range reads as Infinity, which is not a limit.
             (n (and m (let ((v (parse-integer (remove #\, (rx-group m 1)))))
                         (and (< v (expt 2 1024))
                              ;; The double JavaScript reads, written as it writes one past 1e21.
                              (let ((d (dbl v))) (if (< d 1d21) (floor d) d)))))))
        ;; A limit under 1k tokens is a media or message cap, not a context window.
        (when (and n (>= n 1024)) (return n))))))

;;; --- omp's policy and trigger (pi-agent-core resolveThresholdTokens) ----------------

(defparameter +omp-default-reserve-tokens+ 16384)
(defparameter +pi-default-reserve-tokens+ 16384)

(defun omp-policy-of (settings)
  "window.ts ompPolicyOf: the fields of omp's preparation.settings that decide where it compacts."
  (when (json-object-p settings)
    (let ((policy (json-object)))
      (let ((v (json-get settings "enabled"))) (when (member v '(:true :false)) (setf (gethash "enabled" policy) v)))
      (let ((v (json-get settings "strategy"))) (when (stringp v) (setf (gethash "strategy" policy) v)))
      (dolist (key '("thresholdPercent" "thresholdTokens" "baseWindowTokens" "reserveTokens"))
        (let ((v (json-get settings key))) (when (realp v) (setf (gethash key policy) v))))
      policy)))

(defun omp-auto-compacts-p (policy)
  (and (not (eq (json-get policy "enabled") :false)) (not (equal (json-get policy "strategy") "off"))))

(defun finite-positive (v) (and (realp v) (> v 0) v))

(defun omp-reserve (window policy)
  (let* ((proportional (max 1 (floor (* (dbl window) 0.15d0))))
         (set (json-get policy "reserveTokens"))
         (reserve (max (floor (* (dbl window) 0.15d0)) (or set +omp-default-reserve-tokens+))))
    (if (or (and (null set) (>= reserve (- window proportional))) (>= reserve window)) proportional reserve)))

(defun omp-prompt-budget (window policy)
  (max 0 (min (- window 1) (- window (omp-reserve window policy)))))

(defun omp-trigger (window &optional policy)
  "window.ts ompTrigger: where omp compacts on WINDOW under POLICY."
  (let ((fixed (finite-positive (json-get policy "thresholdTokens"))))
    (if fixed
        (if (>= fixed window) (omp-prompt-budget window policy) (min (- window 1) (max 1 fixed)))
        (let* ((base (finite-positive (json-get policy "baseWindowTokens")))
               (scaled (if base (min window base) window))
               (percent (finite-positive (json-get policy "thresholdPercent"))))
          (if percent
              (floor (* (dbl scaled) (/ (dbl (min 99 (max 1 percent))) 100d0)))
              (omp-prompt-budget scaled policy))))))

(defun omp-default-trigger (window) (max 1 (omp-trigger window)))

;;; --- Pi's policy and trigger (its shouldCompact) -------------------------------------

(defun pi-policy-of (settings)
  "window.ts piPolicyOf."
  (when (json-object-p settings)
    (let ((policy (json-object)))
      (let ((v (json-get settings "enabled"))) (when (member v '(:true :false)) (setf (gethash "enabled" policy) v)))
      (let ((v (json-get settings "reserveTokens"))) (when (realp v) (setf (gethash "reserveTokens" policy) v)))
      policy)))

(defun pi-trigger (window &optional policy)
  (let* ((set (json-get policy "reserveTokens"))
         (reserve (if (realp set) (max 0 set) +pi-default-reserve-tokens+)))
    (max 1 (floor (- window reserve)))))

(defun pi-auto-compacts-p (policy) (not (eq (json-get policy "enabled") :false)))

;;; --- the host's rule, by name (TriggerRule.name) -------------------------------------

(defun rule-policy-of (rule settings) (if (equal rule "pi") (pi-policy-of settings) (omp-policy-of settings)))
(defun rule-trigger (rule window policy) (if (equal rule "pi") (pi-trigger window policy) (omp-trigger window policy)))
(defun rule-auto-compacts-p (rule policy) (if (equal rule "pi") (pi-auto-compacts-p policy) (omp-auto-compacts-p policy)))

(defun trigger-for (window recovering tokens-before policy rule)
  "window.ts triggerFor: where this compaction's budgets assume the next one happens."
  (let ((trigger (and (realp window) (/= window 0) (rule-trigger rule window policy)))
        (before (positive-floor tokens-before)))
    ;; A trigger of 0 (a window of 1) is falsy there: the context's count stands alone.
    (if (and recovering before) (if (and trigger (/= trigger 0)) (min trigger before) before) trigger)))

;;; --- the budgets ------------------------------------------------------------------------

(defparameter +landing-share+ 0.6d0)
(defparameter +tail-share+ 0.25d0)
(defparameter +sections-tokens+ 600)
(defparameter +working-set-share+ 0.14d0)
(defparameter +min-working-set-tokens+ 400)
(defparameter +min-tail-tokens+ 1000)
(defparameter +reference-trigger+ (omp-default-trigger 128000))

;; (KEY DEFAULT FLOOR), in DEFAULT_SUMMARY_LIMITS' order.
(defparameter +summary-limits+
  '(("userMessages" 15 4) ("filesPerCategory" 10 3) ("commits" 8 2)
    ("historyRanges" 8 3) ("briefLines" 120 30) ("commandsPerName" 10 3)))

(defun summary-limits (scale)
  (let ((limits (json-object)))
    (loop for (key default floor) in +summary-limits+
          do (setf (gethash key limits) (if (null scale) default (max floor (js-round (* default scale))))))
    limits))

(defun summary-scale (trigger brief-ceiling)
  (if (< trigger +reference-trigger+)
      (max 0.25d0 (sqrt (/ (dbl trigger) (dbl +reference-trigger+))))
      (max 1 (/ (dbl brief-ceiling) 2000d0))))

(defun compaction-budgets (trigger overhead with-working-set)
  "window.ts compactionBudgets."
  (let ((tt (positive-floor trigger)))
    (if (null tt)
        (json-object "maxTailTokens" 25000 "minTailTokens" 5000 "briefTokens" 1100 "briefCeilingTokens" 2000
                     "briefTokensPerBlock" 15 "briefMaxBlocks" 80 "growthMarginChars" 500
                     "summary" (summary-limits nil) "summaryScale" 1
                     "workingSetTokens" (if with-working-set 3800 0))
        (let* ((ceiling (js-round (min (* 0.1d0 tt) (clamp-tokens (* 0.004d0 tt) 2000 6000))))
               (brief (js-round (min 1100 (* 0.06d0 tt) ceiling)))
               (scale (summary-scale tt ceiling))
               (grow (max 1 scale))
               (landing (- (- (- (* +landing-share+ tt) (max 0 overhead)) ceiling) (* +sections-tokens+ scale)))
               (wanted (js-round (min (* 3800 grow) (* +working-set-share+ tt) (- landing +min-tail-tokens+))))
               (working-set (if (and with-working-set (>= wanted +min-working-set-tokens+)) wanted 0))
               (max-tail (clamp-tokens (min (* +tail-share+ tt) (- landing working-set)) +min-tail-tokens+ 25000)))
          (json-object "maxTailTokens" max-tail
                       "minTailTokens" (js-round (/ (dbl max-tail) 5d0))
                       "briefTokens" brief
                       "briefCeilingTokens" ceiling
                       "briefTokensPerBlock" 15
                       "briefMaxBlocks" (js-round (* 80 grow))
                       "growthMarginChars" (js-round (* 500 grow))
                       "summary" (summary-limits scale)
                       "summaryScale" (let ((r (js-round (* scale 100)))) (if (zerop (mod r 100)) (floor r 100) (/ (dbl r) 100d0)))
                       "workingSetTokens" working-set)))))

;;; --- the context, measured (plan.ts sizeCompaction) ---------------------------------

(defun calibrate-chars-per-token (chars tokens)
  "token-estimate.ts calibrateCharsPerToken."
  (if (or (not (realp tokens)) (<= tokens 0) (<= chars 0))
      (json-object "mode" "heuristic" "charsPerToken" +default-chars-per-token+)
      (let ((raw (/ (dbl chars) (dbl tokens))))
        (json-object "mode" "calibrated"
                     "charsPerToken" (let ((c (min 6 (max 2 raw)))) (if (= c (ftruncate c)) (truncate c) c))
                     "sourceChars" chars "sourceTokens" tokens
                     "rawCharsPerToken" (if (= raw (ftruncate raw)) (truncate raw) raw)))))

(defun number-or-zero (v) (or (js-number-of v) 0))

(defun measured-overhead-tokens (branch)
  "Prompt tokens of the session's first request less what its messages account for, or NIL."
  (let ((chars 0))
    (loop for e across branch
          for m = (json-get e "message")
          when (and (equal (json-get e "type") "message") (truthy-p m))
            do (let* ((u (and (equal (json-get m "role") "assistant") (json-get m "usage")))
                      (prompt (if (truthy-p u)
                                  (+ (number-or-zero (json-get u "input")) (number-or-zero (json-get u "cacheRead"))
                                     (number-or-zero (json-get u "cacheWrite")))
                                  0)))
                 (when (> prompt 0) (return-from measured-overhead-tokens (max 0 (- prompt (tokens-from-chars chars)))))
                 (incf chars (message-chars m))))
    nil))

(defun size-compaction (input branch)
  "plan.ts sizeCompaction: the policy, the trigger, the overhead, chars per token, the budgets."
  (let* ((tokens-before (let ((v (json-get input "tokensBefore"))) (and (realp v) v)))
         (previous (let ((p (json-get input "previousSummary"))) (and (stringp p) p)))
         ;; The live messages (cut.ts collectLiveMessages) and the summary before them.
         (content (+ (loop for i from (live-window-start branch) below (length branch)
                           sum (let ((m (live-message (aref branch i)))) (if m (message-chars m) 0)))
                     (if previous (js-length previous) 0)))
         (measured (measured-overhead-tokens branch))
         (estimate (calibrate-chars-per-token
                    content (if (and measured tokens-before (> tokens-before measured)) (- tokens-before measured) tokens-before)))
         (overhead (or measured
                       (if (and tokens-before (> tokens-before 0)) (max 0 (- tokens-before (tokens-from-chars content))) 0)))
         (rule (json-get input "ruleName"))
         (policy (rule-policy-of rule (json-get input "hostSettings")))
         (trigger (trigger-for (json-get input "window") (eq (json-get input "recovering") :true) tokens-before policy rule))
         ;; compactionBudgets' withWorkingSet, true when unset.
         (with-ws (let ((v (json-get (json-get input "settings") "workingSet"))) (or (null v) (truthy-p v)))))
    (json-object "policy" policy "trigger" trigger "overheadTokens" overhead "tokenEstimate" estimate
                 "budgets" (compaction-budgets trigger overhead with-ws))))

;;; --- the window op (server.lisp) ----------------------------------------------------

(defun window-case (c)
  "One case of op window: an overflow error's limit, or the host's trigger and the budgets below it."
  (if (nth-value 1 (gethash "error" c))
      (json-object "limit" (limit-from-overflow-error (json-get c "error")))
      (let* ((rule (json-get c "ruleName"))
             (policy (if (nth-value 1 (gethash "hostSettings" c))
                         (rule-policy-of rule (json-get c "hostSettings"))
                         (json-get c "policy")))
             (trigger (trigger-for (json-get c "window") (eq (json-get c "recovering") :true)
                                   (let ((v (json-get c "tokensBefore"))) (and (realp v) v)) policy rule))
             (overhead (let ((v (json-get c "overheadTokens"))) (if (realp v) v 0))))
        (json-object "policy" policy "trigger" trigger
                     "autoCompacts" (if (rule-auto-compacts-p rule policy) :true :false)
                     "budgets" (compaction-budgets trigger overhead (not (eq (json-get c "workingSet") :false)))))))
