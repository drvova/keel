;;;; args.lisp --- what a compaction command hands the hook, and the hook reads back.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; `/omp-vcc keep:N` becomes customInstructions carrying a marker, so the
;;;; hook knows the pass is the command's; `/compact` text may end or start with
;;;; keep:N and carry a prompt to send once it is done. src/core/compact-args.ts
;;;; asks for both.

(in-package #:omp-vcc)


(defun keep-of (text)
  "keep:N's N when TEXT is keep:N, else NIL; more digits than a safe integer keep as many turns as any session has."
  (let ((m (rx-exec (rx "^keep:(\\d+)$") text)))
    (and m (min (parse-integer (rx-group m 1)) +max-safe-integer+))))

(defun parse-keep-and-prompt (args)
  "ARGS as (values FOLLOW-UP-PROMPT KEEP), keep:N its first word or its last."
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
  "The customInstructions /omp-vcc hands the host: the marker, then keep:N when KEEP is given."
  (if keep (format nil "~a keep:~d" +compact-instruction+ keep) +compact-instruction+))

(defun parse-instructions (custom)
  "The customInstructions a compaction came with, as (values FROM-COMMAND KEEP
FOLLOW-UP-PROMPT): the command's marker and its keep:N, or `/compact` text."
  (let ((trimmed (and (stringp custom) (js-trim custom))))
    (if (and trimmed (or (string= trimmed +compact-instruction+)
                         (starts-with (format nil "~a " +compact-instruction+) trimmed)))
        (values t (nth-value 1 (parse-keep-and-prompt (js-slice trimmed (js-length +compact-instruction+)))) nil)
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
