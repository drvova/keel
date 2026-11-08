;;;; blocks.lisp --- a window's messages as the summary reads them.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Text sanitized (terminal escapes, control characters), host noise left out
;;;; (omp's reminders), skill bodies collapsed, and each message normalized into
;;;; blocks (user, assistant, tool_call, tool_result, bash), the unit every
;;;; section is built from; with what the summary reads of a block (its command,
;;;; a call's files).

(in-package #:keel)

;;; --- text a host or a terminal put in --------------------------------------

(defun sanitize (text)
  "TEXT with CRLF and CR as LF, ANSI escapes and other control characters removed."
  ;; Most text holds no control character at all, and is its own answer.
  (when (notany (lambda (c) (let ((code (char-code c))) (and (< code 32) (/= code 9) (/= code 10)))) text)
    (return-from sanitize text))
  (let ((s (rx-replace (rx "\\r\\n") text (string #\Newline) :all t)))
    (setf s (rx-replace (rx "\\r") s (string #\Newline) :all t))
    (setf s (rx-replace (rx "\\x1b\\[[0-9;]*[A-Za-z]") s "" :all t))
    (rx-replace (rx "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]") s "" :all t)))

(defun collapse-skill-text (text)
  "Each expanded <skill name=\"X\">…</skill> block as `[skill: X]`."
  (if (not (search "<skill" text))
      text
      (rx-replace (skill-block-regex) text (lambda (m) (format nil "[skill: ~a]" (rx-group m 1))) :all t)))

;;; --- blocks ------------------------------------------------------------------

(defstruct (blk (:conc-name block-) (:constructor make-block) (:copier copy-block) (:predicate block-p))
  "One block: what a message said or did."
  kind            ; :user :assistant :tool-call :tool-result :bash
  (text "")
  index           ; the message's #N, or NIL
  injected
  id name args failed
  results         ; a tool call's: the texts of the results that answer it (calls.lisp pairs them)
  call-id
  command output exit-code lang)

(defun index-or (v) (if (integerp v) v nil))

(defun call-key (pos id) (format nil "~d:~a" pos id))

(defun normalize-one (message index pairs &optional (pos 0))
  (let ((role (json-get message "role")) (content (json-get message "content")))
    (cond
      ((equal role "user")
       (let ((text (sanitize (text-of content))) (blocks '()))
         (when (plusp (length text))
           (push (make-block :kind :user :text text :index index
                             :injected (eq (json-get message "injected") :true))
                 blocks))
         (when (and content (not (stringp content)) (vectorp content))
           (loop for part across content
                 when (and (json-object-p part) (equal (json-get part "type") "image"))
                   do (push (make-block :kind :user :text (format nil "[image: ~a]" (js-string-of (json-get part "mimeType"))) :index index) blocks)))
         (if blocks (nreverse blocks) (list (make-block :kind :user :text "" :index index)))))
      ((execution-of message)
       (multiple-value-bind (command output prompt label lang) (execution-of message)
         (declare (ignore prompt label))
         (list (make-block :kind :bash :command command :output output :exit-code (json-get message "exitCode") :index index :lang lang))))
      ((equal role "toolResult")
       (list (make-block :kind :tool-result
                         :call-id (let ((id (json-get message "toolCallId"))) (and (stringp id) id))
                         :name (json-get message "toolName")
                         :text (sanitize (text-of content)) :index index)))
      ((equal role "assistant")
       (cond ((not (truthy-p content)) '())
             ((stringp content) (list (make-block :kind :assistant :text (sanitize content) :index index)))
             (t (loop for part across content
                      append (cond ((equal (json-get part "type") "text")
                                    (list (make-block :kind :assistant :text (sanitize (json-get part "text")) :index index)))
                                   ((equal (json-get part "type") "toolCall")
                                    (let* ((c (part-call part)) (id (call-id c))
                                           (answers (and id (gethash (call-key pos id) pairs))))
                                      (list (make-block :kind :tool-call :id id :name (call-name c) :args (call-args c) :index index
                                                        :failed (and (some #'result-error answers) t)
                                                        :results (mapcar #'result-text answers))))))))))
      (t '()))))

(defun nonzero-exit-p (code)
  "`exitCode != null && exitCode !== 0`."
  (and code (not (eq code :null)) (not (eql code 0))))

(defun filter-noise (blocks)
  "BLOCKS without omp's <system-reminder> text in user messages, and without a
user message that held only that."
  (loop for b in blocks
        append (if (eq (block-kind b) :user)
                   (let ((text (js-trim (if (search "<system-reminder" (block-text b))
                                            (rx-replace (host-block-regex) (block-text b) "" :all t)
                                            (block-text b)))))
                     (if (plusp (length text))
                         (let ((copy (copy-block b))) (setf (block-text copy) text) (list copy))
                         '()))
                   (list b))))

(defun summary-blocks (messages indices)
  "The blocks of MESSAGES (JSON objects), each with its #N from INDICES (a
vector parallel to MESSAGES, or NIL for positions), host noise left out."
  (let* ((readable (map 'list (lambda (m) (and (json-object-p m) (readable-message m))) messages))
         ;; Each call's results, paired as [Task State] and [Working Set] pair them (calls.lisp).
         (pairs (make-hash-table :test 'equal)))
    (dolist (r (reverse (nth-value 1 (read-calls readable))))
      (let ((c (result-call r)))
        (when c (push r (gethash (call-key (call-pos c) (call-id c)) pairs)))))
    (filter-noise
     (loop for m in readable
           for i from 0
           when m append (normalize-one m (if indices (and (< i (length indices)) (index-or (aref indices i))) i) pairs i)))))

;;; --- what a block runs and works on --------------------------------------------

(defun block-call (b) (make-call (block-name b) (block-args b)))

(defun command-of (b)
  "The shell command a block ran: a shell call's `command`, or a `!cmd` the user ran."
  (case (block-kind b)
    (:bash (and (null (block-lang b)) (block-command b)))
    (:tool-call (and (eq (call-kind (block-call b)) :shell)
                     (let ((c (json-get (block-args b) "command"))) (and (stringp c) c))))))

