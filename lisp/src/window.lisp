;;;; window.lisp --- where the host compacts next, and the budgets that land below it.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Limits that follow the model's context window instead of fixed numbers.
;;;;
;;;; omp knows a model's window from its provider (with discovery configured),
;;;; its catalog, models.yml or a 128K default, and compacts at a trigger below
;;;; it (the window less a reserve, or the user's threshold). After a compaction
;;;; the context must land inside omp's recovery band (80% of the trigger) or
;;;; omp treats it as a dead end and starts shaking tool output; a 25k-token kept
;;;; tail does that on a small window, and a 2k-token summary is needlessly thin
;;;; on a 1M one. So the tail, the smart-keep trigger, the summary budget, the
;;;; size of each summary section and the growth a summary may add are shares of
;;;; the trigger, clamped like the recall cap (recall.lisp recall-output-chars):
;;;; the same numbers as before on a typical 128K window, smaller below it, a
;;;; larger summary far above it.
;;;;
;;;; The window is the smaller of the host's and a limit an overflow error
;;;; stated (limits.lisp); omp-vcc makes no network call. The trigger is the
;;;; host's own: its compaction policy (omp: threshold, reserve, the model's
;;;; entry; Pi: its reserve) arrives with every compaction (preparation.settings),
;;;; and the host's rule applies it to that window as the host does. Pi
;;;; re-compacts only past its trigger, so the landing below omp's recovery band
;;;; suits it too. Also here: the context measure a compaction is sized from (the
;;;; chars per token, calibrated on the context the host counted).
;;;;
;;;; JavaScript did this arithmetic on doubles, so it is done on doubles here, in
;;;; the order it was written; a division never makes a ratio.

(in-package #:omp-vcc)

(defun dbl (x) (coerce x 'double-float))

(defun positive (v) "V when it is a number over 0, else NIL." (and (realp v) (> v 0) v))
(defun positive-floor (v) "V floored when it is a number over 0, else NIL." (let ((p (positive v))) (and p (floor p))))

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
  "The context limit an overflow error states, or NIL."
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
  "The fields of omp's preparation.settings that decide where it compacts."
  (when (json-object-p settings)
    (let ((policy (json-object)))
      (let ((v (json-get settings "enabled"))) (when (member v '(:true :false)) (setf (gethash "enabled" policy) v)))
      (let ((v (json-get settings "strategy"))) (when (stringp v) (setf (gethash "strategy" policy) v)))
      (dolist (key '("thresholdPercent" "thresholdTokens" "baseWindowTokens" "reserveTokens"))
        (let ((v (json-get settings key))) (when (realp v) (setf (gethash key policy) v))))
      policy)))

(defun omp-auto-compacts-p (policy)
  (and (not (eq (json-get policy "enabled") :false)) (not (equal (json-get policy "strategy") "off"))))

(defun omp-reserve (window policy)
  (let* ((proportional (max 1 (floor (* (dbl window) 0.15d0))))
         (set (json-get policy "reserveTokens"))
         (reserve (max (floor (* (dbl window) 0.15d0)) (or set +omp-default-reserve-tokens+))))
    (if (or (and (null set) (>= reserve (- window proportional))) (>= reserve window)) proportional reserve)))

(defun omp-prompt-budget (window policy)
  (max 0 (min (- window 1) (- window (omp-reserve window policy)))))

(defun omp-trigger (window &optional policy)
  "Where omp compacts on WINDOW under POLICY: pi-agent-core's resolveThresholdTokens,
which omp does not export to extensions. A fixed token threshold is exact unless
it is at or past the window (then the window less its reserve); otherwise a
percentage of the window (or of a model entry's base), or by default the window
less a reserve of 15% or 16,384 tokens, whichever is larger (15% alone when that
would not fit). tests/window.test.ts holds it to omp's own."
  (let ((fixed (positive (json-get policy "thresholdTokens"))))
    (if fixed
        (if (>= fixed window) (omp-prompt-budget window policy) (min (- window 1) (max 1 fixed)))
        (let* ((base (positive (json-get policy "baseWindowTokens")))
               (scaled (if base (min window base) window))
               (percent (positive (json-get policy "thresholdPercent"))))
          (if percent
              (floor (* (dbl scaled) (/ (dbl (min 99 (max 1 percent))) 100d0)))
              (omp-prompt-budget scaled policy))))))

;;; --- Pi's policy and trigger (its shouldCompact) -------------------------------------

(defun pi-policy-of (settings)
  "The policy fields in Pi's preparation.settings (enabled, reserveTokens), or NIL when it is not an object."
  (when (json-object-p settings)
    (let ((policy (json-object)))
      (let ((v (json-get settings "enabled"))) (when (member v '(:true :false)) (setf (gethash "enabled" policy) v)))
      (let ((v (json-get settings "reserveTokens"))) (when (realp v) (setf (gethash "reserveTokens" policy) v)))
      policy)))

(defun pi-trigger (window &optional policy)
  "Where Pi compacts on WINDOW: its shouldCompact, contextTokens > contextWindow -
reserveTokens, which Pi applies with `enabled` on. A reserve at or past the window
would compact every turn; the trigger is then 1."
  (let* ((set (json-get policy "reserveTokens"))
         (reserve (if (realp set) (max 0 set) +pi-default-reserve-tokens+)))
    (max 1 (floor (- window reserve)))))

(defun pi-auto-compacts-p (policy) (not (eq (json-get policy "enabled") :false)))

;;; --- the host's rule, by name (TriggerRule.name) -------------------------------------

(defparameter +rules+
  `(("omp" ,#'omp-policy-of ,#'omp-trigger ,#'omp-auto-compacts-p)
    ("pi" ,#'pi-policy-of ,#'pi-trigger ,#'pi-auto-compacts-p))
  "Each host's rule: (NAME POLICY-OF TRIGGER AUTO-COMPACTS-P).")

(defun rule-of (name)
  "NAME's rule; no name is omp's (a test op that names no host). A name no host has is a bug."
  (rest (cond ((null name) (first +rules+))
              ((assoc name +rules+ :test #'equal))
              (t (error "No trigger rule for the host ~s." name)))))
(defun rule-policy-of (rule settings) (funcall (first (rule-of rule)) settings))
(defun rule-trigger (rule window policy) (funcall (second (rule-of rule)) window policy))
(defun rule-auto-compacts-p (rule policy) (funcall (third (rule-of rule)) policy))

(defun trigger-for (window recovering tokens-before policy rule)
  "Where this compaction's budgets assume the next one happens: the host's
POLICY applied to the effective WINDOW as the host applies it (RULE). When the
host's window is too high its trigger can never fire, and the same policy on the
real window applies. A recovery pass is bounded by the context that overflowed."
  (let ((trigger (and (realp window) (/= window 0) (rule-trigger rule window policy)))
        (before (positive-floor tokens-before)))
    ;; A trigger of 0 (a window of 1) is falsy there: the context's count stands alone.
    (if (and recovering before) (if (and trigger (/= trigger 0)) (min trigger before) before) trigger)))

;;; --- the budgets ------------------------------------------------------------------------

;; omp re-compacts unless a compaction lands at or under 80% of the trigger (its
;; recovery band); omp-vcc aims lower, so the turn after it has room before the next.
(defparameter +landing-share+ 0.6d0)
(defparameter +tail-share+ 0.25d0 "The kept tail is at most this share of the trigger.")
(defparameter +sections-tokens+ 600 "A rough allowance for the summary's sections around the brief, at full size.")
;; [Working Set] takes at most this share of the trigger, and nothing when that is
;; under the floor. A smaller window needs it most: in real runs on a 40K window,
;; a 3.5% share (about 3k chars) held no whole source file, and the agent read the
;; files again; 14% holds them. On a ~128K window the 3,800-token cap binds first.
(defparameter +working-set-share+ 0.14d0)
(defparameter +min-working-set-tokens+ 400)
(defparameter +min-tail-tokens+ 1000 "The kept tail's floor: the working set takes only the landing room above it.")
(defparameter +reference-trigger+ (omp-trigger 128000) "omp's trigger on a 128K window: where the numbers below were tuned, and what an unknown trigger is taken to be.")

;; (KEY DEFAULT FLOOR), in the order the summary limits are written: DEFAULT is
;; the size on a ~128K window, FLOOR the least it scales down to.
(defparameter +summary-limits+
  '(("userMessages" 15 4) ("filesPerCategory" 10 3) ("commits" 8 2)
    ("historyRanges" 8 3) ("briefLines" 120 30) ("commandsPerName" 10 3)))

(defun summary-limits (scale)
  (let ((limits (json-object)))
    (loop for (key default floor) in +summary-limits+
          do (setf (gethash key limits) (max floor (js-round (* default scale)))))
    limits))

(defun summary-scale (trigger brief-ceiling)
  "How much of each section list a summary keeps, against a ~128K window. Below
it, the square root of the trigger's share (a 32K window keeps about 40%), never
under a quarter: a small window needs the room, but the lists are where a long
task keeps its bearings. Above it, nothing changes until the brief's ceiling
grows (a trigger past 500K), then the lists grow with it."
  (if (< trigger +reference-trigger+)
      (max 0.25d0 (sqrt (/ (dbl trigger) (dbl +reference-trigger+))))
      (max 1 (/ (dbl brief-ceiling) 2000d0))))

(defun compaction-budgets (trigger overhead with-working-set)
  "Budgets for a compaction that runs at TRIGGER tokens, with OVERHEAD of context
it cannot remove (system prompt, tool schemas): what is kept plus the summary lands
at or under +landing-share+ of the trigger. An unknown trigger is taken as a
~128K window's, with nothing it cannot remove. Without a
working set (the setting off), its room goes to the kept tail."
  (let* ((known (positive-floor trigger))
         (tt (or known +reference-trigger+))
         (overhead (if known overhead 0)))
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
                   "briefMaxBlocks" (js-round (* +brief-max-blocks+ grow))
                   "growthMarginChars" (js-round (* 500 grow))
                   "summary" (summary-limits scale)
                   "summaryScale" (let ((r (js-round (* scale 100)))) (if (zerop (mod r 100)) (floor r 100) (/ (dbl r) 100d0)))
                   "workingSetTokens" working-set))))

;;; --- the context, measured ---------------------------------------------------------

(defun calibrate-chars-per-token (chars tokens)
  "Chars per token from CHARS of messages the host counted as TOKENS, clamped to
2..6; the 4-char heuristic when the host counted none."
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

(defun working-set-on-p (v) "The workingSet setting: on unless set false." (not (eq v :false)))

(defun size-compaction (input branch)
  "What a compaction is sized from: the policy, the trigger, the overhead, chars
per token, the budgets. The overhead (system prompt, tool schemas) is measured
on the session's first request, whose prompt held little else; without one, the
counted context less what the messages account for at 4 chars per token, which
overstates it for dense text. Chars per token are calibrated on the messages
alone, so a token budget maps to the chars the messages take."
  (let* ((tokens-before (let ((v (json-get input "tokensBefore"))) (and (realp v) v)))
         (previous (let ((p (json-get input "previousSummary"))) (and (stringp p) p)))
         ;; The live messages (LIVE-WINDOW-START on) and the summary before them.
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
         (with-ws (working-set-on-p (json-get (json-get input "settings") "workingSet"))))
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
             ;; A trigger the case names is taken as it is, for the budgets below it.
             (trigger (if (realp (json-get c "trigger"))
                          (json-get c "trigger")
                          (trigger-for (json-get c "window") (eq (json-get c "recovering") :true)
                                       (let ((v (json-get c "tokensBefore"))) (and (realp v) v)) policy rule)))
             (overhead (let ((v (json-get c "overheadTokens"))) (if (realp v) v 0))))
        (json-object "policy" policy "trigger" trigger
                     "autoCompacts" (if (rule-auto-compacts-p rule policy) :true :false)
                     "budgets" (compaction-budgets trigger overhead (working-set-on-p (json-get c "workingSet")))))))
