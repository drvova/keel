;;;; args.lisp --- what a compaction command hands the hook, and the hook reads back.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/compact-args.ts. `/omp-vcc keep:N` becomes
;;;; customInstructions carrying a marker, so the hook knows the pass is the
;;;; command's; `/compact` text may end or start with keep:N and carry a prompt
;;;; to send once it is done. The regexes are the TS's, on the same engine.

(in-package #:omp-vcc)

(defparameter +omp-vcc-instruction+ "__omp_vcc__"
  "What /omp-vcc hands the hook for the manual pass it starts; `keep:N` may follow.")
(defparameter +max-safe-keep+ 9007199254740991 "Number.MAX_SAFE_INTEGER.")

(defun keep-of (text)
  "keep:N's N when TEXT is keep:N, else NIL; more digits than a safe integer keep as many turns as any session has."
  (let ((m (rx-exec (rx "^keep:(\\d+)$") text)))
    (and m (min (parse-integer (rx-group m 1)) +max-safe-keep+))))

(defun parse-keep-and-prompt (args)
  "compact-args.ts parseKeepAndPrompt: (values FOLLOW-UP-PROMPT KEEP), keep:N first or last."
  (let* ((trimmed (if (stringp args) (js-trim args) ""))
         (first (rx-exec (rx "^(\\S+)(?:\\s+([\\s\\S]*))?$") trimmed))
         (first-keep (and first (keep-of (rx-group first 1)))))
    (if first-keep
        (values (js-trim (or (rx-group first 2) "")) first-keep)
        (let* ((last (rx-exec (rx "(?:^|\\s)(\\S+)$") trimmed))
               (last-keep (and last (keep-of (rx-group last 1)))))
          (if last-keep
              (values (js-trim (js-slice trimmed 0 (- (js-length trimmed) (js-length (rx-group last 1))))) last-keep)
              (values trimmed nil))))))

(defun vcc-custom-instructions (keep)
  "compact-args.ts buildVccCustomInstructions."
  (if keep (format nil "~a keep:~d" +omp-vcc-instruction+ keep) +omp-vcc-instruction+))

(defun parse-instructions (custom)
  "compact-args.ts parseInstructions: (values FROM-COMMAND KEEP FOLLOW-UP-PROMPT)."
  (let ((trimmed (and (stringp custom) (js-trim custom))))
    (if (and trimmed (or (string= trimmed +omp-vcc-instruction+)
                         (starts-with (format nil "~a " +omp-vcc-instruction+) trimmed)))
        (values t (nth-value 1 (parse-keep-and-prompt (js-slice trimmed (js-length +omp-vcc-instruction+)))) nil)
        (multiple-value-bind (prompt keep) (parse-keep-and-prompt custom)
          (values nil keep (and (plusp (length prompt)) prompt))))))

(defun handle-args (request)
  "Op args: the hook's reading of customInstructions (\"instructions\"), or the
command's of its text (\"command\": the prompt, keep:N and the instructions it hands the host)."
  (if (nth-value 1 (gethash "command" request))
      (multiple-value-bind (prompt keep) (parse-keep-and-prompt (json-get request "command"))
        (json-object "ok" :true "followUpPrompt" prompt "keepUserTurns" (or keep :null)
                     "instructions" (vcc-custom-instructions keep)))
      (multiple-value-bind (from-command keep prompt) (parse-instructions (json-get request "instructions"))
        (json-object "ok" :true "fromCommand" (if from-command :true :false)
                     "keepUserTurns" (or keep :null) "followUpPrompt" (or prompt :null)))))
