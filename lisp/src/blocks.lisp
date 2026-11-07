;;;; blocks.lisp --- a window's messages as the summary reads them.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/sanitize.ts, filter-noise.ts, skill-collapse.ts,
;;;; normalize.ts and the parts of tools.ts the summary reads (a block's
;;;; command, a call's files): each message becomes blocks (user, assistant,
;;;; tool_call, tool_result, bash), the unit every section is built from.

(in-package #:omp-vcc)

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

(defun skill-block-regex () (rx "<skill\\s+name=\"([^\"]+)\"[^>]*>[\\s\\S]*?(?:<\\/skill>|$)"))

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
  call-id
  command output exit-code lang)

(defun index-or (v) (if (integerp v) v nil))

(defun normalize-one (message index failed-ids)
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
      ((equal role "bashExecution")
       (list (make-block :kind :bash :command (or-empty (json-get message "command")) :output (or-empty (json-get message "output"))
                         :exit-code (json-get message "exitCode") :index index)))
      ((equal role "pythonExecution")
       (list (make-block :kind :bash :command (or-empty (json-get message "code")) :output (or-empty (json-get message "output"))
                         :exit-code (json-get message "exitCode") :index index :lang "python")))
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
                                    (let ((id (let ((i (json-get part "id"))) (and (stringp i) i))))
                                      (list (make-block :kind :tool-call :id id :name (string-or (json-get part "name") "unknown")
                                                        :args (let ((a (json-get part "arguments"))) (if (json-object-p a) a (make-hash-table :test 'equal)))
                                                        :index index :failed (and id (gethash id failed-ids) t))))))))))
      (t '()))))

(defun nonzero-exit-p (code)
  "`exitCode != null && exitCode !== 0`."
  (and code (not (eq code :null)) (not (eql code 0))))

(defun host-block-regex () (rx "<system-reminder\\b[^>]*>[\\s\\S]*?<\\/system-reminder>"))

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
         (failed (make-hash-table :test 'equal)))
    (dolist (m readable)
      (when (and m (equal (json-get m "role") "toolResult") (eq (json-get m "isError") :true)
                 (stringp (json-get m "toolCallId")))
        (setf (gethash (json-get m "toolCallId") failed) t)))
    (filter-noise
     (loop for m in readable
           for i from 0
           when m append (normalize-one m (if indices (and (< i (length indices)) (index-or (aref indices i))) i) failed)))))

;;; --- what a block runs and works on --------------------------------------------

(defun block-call (b) (make-call (block-name b) (block-args b)))

(defun command-of (b)
  "The shell command a block ran: a shell call's `command`, or a `!cmd` the user ran."
  (case (block-kind b)
    (:bash (and (null (block-lang b)) (block-command b)))
    (:tool-call (and (eq (call-kind (block-call b)) :shell)
                     (let ((c (json-get (block-args b) "command"))) (and (stringp c) c))))))

(defun url-path-p (path) (rx-test (rx "^[a-z][a-z0-9+.-]*:\\/\\/" "i") path))

(defun read-selector-regex ()
  (rx ":(?:raw|img|conflicts|L?\\d+(?:(?:-|\\.\\.|\\+)L?\\d*)?|-\\d+(?:[-+]\\d+)?)(?:[,:](?:raw|img|conflicts|L?\\d+(?:(?:-|\\.\\.|\\+)L?\\d*)?|-\\d+(?:[-+]\\d+)?))*$" "i"))

(defun strip-read-selector (path)
  "A read's path without omp's selector (`:50-100`, `:raw`)."
  (let ((m (rx-exec (read-selector-regex) path)))
    (if (and m (plusp (rx-match-start m))) (js-slice path 0 (rx-match-start m)) path)))

(defun files-of (call)
  "The files a call works on: its named paths less URLs, a read's selector dropped; none for a search or a shell."
  (let ((kind (call-kind call)))
    (if (member kind '(:search :shell))
        '()
        (let ((paths (remove-if #'url-path-p (named-paths (call-args call)))))
          (if (eq kind :read) (mapcar #'strip-read-selector paths) paths)))))

(defun pin-call-of (args)
  "A vcc_pin call as the tool reads it: (:note TEXT), (:unpin VALUE), :both or :list."
  (let* ((raw (json-get args "note"))
         (note (and (stringp raw) (not (unset-p raw)) raw))
         (unpin (let ((u (json-get args "unpin"))) (if (unset-p u) nil u))))
    (cond ((and note unpin) :both)
          (note (list :note note))
          (unpin (list :unpin unpin))
          (t :list))))
