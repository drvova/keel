;;;; render.lisp --- a message as recall shows it and as search reads it.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A message made readable whatever it holds, a tool call read (its kind, its
;;;; paths, its subject, its argument text), the one-line view a range or a
;;;; search shows, and the full text expand shows and search reads.
;;;; tests/recall-render.test.ts and the shape tests drive it through recall.
;;;;
;;;; Messages are the JSON objects the session file holds (json.lisp's
;;;; hash tables), read in JavaScript's key order (JSON-KEYS).

(in-package #:omp-vcc)

(defun json-object-p (v) (hash-table-p v))

(defun string-or (v default) (if (stringp v) v default))

;;; --- content ---------------------------------------------------------------

(defun readable-message (message)
  "MESSAGE as recall can read it: a content that is no list is empty, a null
part is dropped, a tool call's name is a string and its arguments an object,
a text part's text is a string."
  (multiple-value-bind (content present) (gethash "content" message)
    (cond ((or (not present) (stringp content)) message)
          ((not (vectorp content))
           (let ((copy (copy-object message))) (setf (gethash "content" copy) "") copy))
          (t
           (let ((copy (copy-object message)))
             (setf (gethash "content" copy)
                   (coerce (loop for part in (object-parts content)
                                 collect (cond ((equal (json-get part "type") "toolCall")
                                                (let ((p (copy-object part)))
                                                  (setf (gethash "name" p) (string-or (json-get part "name") "unknown")
                                                        (gethash "arguments" p) (let ((a (json-get part "arguments")))
                                                                                  (if (json-object-p a) a (make-hash-table :test 'equal))))
                                                  p))
                                               ((and (equal (json-get part "type") "text") (not (stringp (json-get part "text"))))
                                                (let ((p (copy-object part))) (setf (gethash "text" p) "") p))
                                               (t part)))
                           'vector))
             copy)))))

(defun text-parts (content)
  (cond ((not (truthy-p content)) '())
        ((stringp content) (list content))
        ((vectorp content)
         (loop for part across content
               when (and (json-object-p part) (equal (json-get part "type") "text") (stringp (json-get part "text")))
                 collect (json-get part "text")))
        (t '())))

(defun text-of (content)
  "The text of CONTENT, its text parts joined by newlines."
  (let ((parts (text-parts content)))
    (if (and parts (null (rest parts)))
        (first parts)
        (join-strings parts (string #\Newline)))))

;;; --- tool calls --------------------------------------------------------------

(defstruct (call (:constructor make-call (name args &optional id pos)))
  "One tool call: its name (\"unknown\" when it has none), its arguments (an
empty object when they are not one), its id when it has one, the place of the
message that made it when the reader counts them, and the files it works on,
read once."
  name args id pos (files :unset))

(defun part-call (part &optional pos)
  "A toolCall content part as a call: the one reading of one."
  (make-call (string-or (json-get part "name") "unknown")
             (let ((a (json-get part "arguments"))) (if (json-object-p a) a (make-hash-table :test 'equal)))
             (let ((id (json-get part "id"))) (and (stringp id) id))
             pos))

(defun tool-calls-of (message &optional pos)
  "MESSAGE's tool calls, in order."
  (let ((content (json-get message "content")))
    (when (json-array-p content)
      (loop for part across content
            when (and (json-object-p part) (equal (json-get part "type") "toolCall"))
              collect (part-call part pos)))))

(defun own-tool-p (name tool)
  (and (stringp name) (string= (string-downcase name) tool)))

(defparameter +kind-by-name+
  '(("read" . :read) ("write" . :write) ("edit" . :edit) ("apply_patch" . :edit) ("ast_edit" . :edit)
    ("grep" . :search) ("glob" . :search) ("find" . :search) ("ast_grep" . :search) ("ls" . :search)
    ("bash" . :shell) ("powershell" . :shell))
  "The kind of the hosts' own tools by name.")

(defparameter +path-keys+ '("path" "file_path" "filePath" "file"))

(defun path-key-of (args)
  (find-if (lambda (k) (let ((v (json-get args k))) (and (stringp v) (plusp (length v))))) +path-keys+))

(defun js-lines (text)
  "TEXT split at JavaScript's line terminators, as ^ and $ see lines under /m."
  (let ((lines '()) (start 0))
    (loop for i from 0 below (length text)
          for code = (char-code (char text i))
          when (member code '(10 13 #x2028 #x2029))
            do (push (subseq text start i) lines) (setf start (1+ i)))
    (push (subseq text start) lines)
    (nreverse lines)))

(defun hex-digit-p (c) (digit-char-p c 16))

(defun hashline-header (line)
  "The PATH of an omp hashline section header `[PATH#TAG]`, TAG four hex digits."
  (let ((close (position #\] line)))
    (when (and (plusp (length line)) (char= (char line 0) #\[) close (>= close 7)
               (char= (char line (- close 5)) #\#)
               (every #'hex-digit-p (subseq line (- close 4) close))
               (every (lambda (c) (member c '(#\Space #\Tab))) (subseq line (1+ close))))
      (subseq line 1 (- close 5)))))

(defparameter +apply-patch-prefixes+ '("*** Add File: " "*** Update File: " "*** Delete File: " "*** Move to: "))

(defun apply-patch-header (line)
  "The file of an omp apply_patch header (`*** Update File: src/app.py`)."
  (dolist (prefix +apply-patch-prefixes+)
    (when (and (> (length line) (length prefix)) (string= prefix line :end2 (length prefix)))
      (return (string-right-trim '(#\Space #\Tab) (subseq line (length prefix)))))))

(defun input-paths (input)
  "The files named in an omp edit's `input`: hashline headers, then apply_patch headers."
  (when (stringp input)
    (let* ((lines (js-lines input))
           (found (append (remove nil (mapcar #'hashline-header lines))
                          (remove nil (mapcar #'apply-patch-header lines)))))
      (remove-duplicates (remove "" (mapcar #'js-trim found) :test #'string=) :test #'string= :from-end t))))

(defun named-paths (args)
  "Every path a call names: its path argument, else `paths`, else the files in an omp edit's `input`."
  (let ((key (path-key-of args)))
    (cond (key (list (json-get args key)))
          ((let ((paths (json-get args "paths"))) (json-array-p paths))
           (loop for p across (json-get args "paths") when (and (stringp p) (plusp (length p))) collect p))
          (t (input-paths (json-get args "input"))))))

(defun call-kind (call)
  (or (cdr (assoc (string-downcase (call-name call)) +kind-by-name+ :test #'string=))
      (let ((args (call-args call)))
        (cond ((null (named-paths args)) :other)
              ((stringp (json-get args "content")) :write)
              ((or (stringp (json-get args "oldText")) (stringp (json-get args "old_string"))
                   (stringp (json-get args "newText")) (stringp (json-get args "new_string"))
                   (let ((edits (json-get args "edits")))
                     (and (json-array-p edits) (some #'json-object-p edits))))
               :edit)
              (t :other)))))

(defun call-subject (call)
  "What CALL is about as (LABEL VALUE MORE): a shell call's command, a search's
pattern, else its file (and how many more it names), command or query."
  (let* ((args (call-args call))
         (kind (call-kind call)))
    (flet ((one (label key)
             (let ((v (json-get args key)))
               (and (stringp v) (plusp (length v)) (list label v 0)))))
      (cond ((eq kind :shell) (one "command" "command"))
            ((and (eq kind :search) (or (one "pattern" "pattern") (one "pattern" "pat"))))
            ((named-paths args)
             (let ((paths (named-paths args))) (list "path" (first paths) (1- (length paths)))))
            (t (or (one "command" "command") (one "query" "query")))))))

(defun call-line (call)
  "A call in one line: `name(label=value)`, else its argument names."
  (let ((subject (call-subject call)))
    (format nil "~a(~a)" (call-name call)
            (if subject
                (destructuring-bind (label value more) subject
                  (format nil "~a=~a~:[~; +~d~]" label value (plusp more) more))
                (join-strings (json-keys (call-args call)) ", ")))))

(defun args-text (args)
  "Every string argument of a call: top-level strings and strings one level into arrays."
  (let ((parts '()))
    (dolist (value (json-values args))
      (cond ((stringp value) (push value parts))
            ((vectorp value)
             (loop for item across value
                   do (cond ((stringp item) (push item parts))
                            ((json-object-p item)
                             (dolist (v (json-values item)) (when (stringp v) (push v parts)))))))))
    (join-strings (nreverse parts) (string #\Newline))))

;;; --- one message, rendered -----------------------------------------------------

(defun file-mention-paths (message)
  (let ((files (json-get message "files")))
    (when (json-array-p files)
      (loop for f across files
            for p = (json-get f "path")
            when (and (stringp p) (plusp (length p))) collect p))))

(defun call-subject-keys (call)
  "The arguments CALL's subject shows (CALL-SUBJECT's keys), so the full view leaves them out."
  (let* ((args (call-args call)) (kind (call-kind call)))
    (flet ((key-if (key) (let ((v (json-get args key))) (and (stringp v) (plusp (length v)) (list key)))))
      (cond ((eq kind :shell) (key-if "command"))
            ((and (eq kind :search) (or (key-if "pattern") (key-if "pat"))))
            ((named-paths args)
             (let ((key (or (path-key-of args) (and (json-array-p (json-get args "paths")) "paths"))))
               (and key (list key))))
            (t (or (key-if "command") (key-if "query")))))))

(defun file-write-of (call)
  "What a write or edit puts in its file, as (:path P :content C), (:path P :edits ((OLD . NEW)...)) or (:path P :replace (OLD . NEW)); NIL for another call."
  (let ((kind (call-kind call)) (args (call-args call)))
    (when (member kind '(:write :edit))
      (let ((key (path-key-of args)))
        (when key
          (let ((path (json-get args key)) (content (json-get args "content")))
            (flet ((old-of (o) (or (string-or (json-get o "oldText") nil) (string-or (json-get o "old_string") nil)))
                   (new-of (o) (or (string-or (json-get o "newText") nil) (string-or (json-get o "new_string") nil))))
              (let ((edits (let ((e (json-get args "edits"))) (and (json-array-p e) (remove-if-not #'json-object-p (coerce e 'list))))))
                (cond ((and (stringp content) (plusp (length content))) (list :path path :content content))
                      ((some (lambda (e) (or (old-of e) (new-of e))) edits)
                       (list :path path :edits (loop for e in edits when (or (old-of e) (new-of e)) collect (cons (or (old-of e) "") (or (new-of e) "")))))
                      ((or (old-of args) (new-of args)) (list :path path :replace (cons (or (old-of args) "") (or (new-of args) "")))))))))))))

(defparameter +not-arguments+ '("i") "omp's per-call intent line: not an argument of the call.")

(defun indent-lines (text pad)
  "TEXT with PAD before every line that holds a character: replace(/^(?=.)/gm, pad)."
  (rx-replace (rx "^(?=.)" "m") text pad :all t))

(defun full-tool-args (calls index chars via)
  "The arguments the one-line summary leaves out, clipped at CHARS."
  (let* ((blocks (remove nil
                         (mapcar (lambda (c)
                                   (let* ((shown (call-subject-keys c))
                                          (lines (loop for key in (json-keys (call-args c))
                                                       for value = (gethash key (call-args c))
                                                       unless (or (member key shown :test #'string=) (member key +not-arguments+ :test #'string=))
                                                         collect (format nil "~a: ~a" key
                                                                         (rx-replace (rx "\\n") (if (stringp value) (rx-replace (rx "\\s+$") value "") (json-string value))
                                                                                     (format nil "~%  ") :all t)))))
                                     (and lines (cons (call-name c) lines))))
                                 calls)))
         (labelled (> (length blocks) 1))
         (text (join-strings (mapcar (lambda (b) (if labelled
                                                     (format nil "  ~a:~%~a" (car b) (indent-lines (join-strings (cdr b) (string #\Newline)) "    "))
                                                     (indent-lines (join-strings (cdr b) (string #\Newline)) "  ")))
                                     blocks)
                             (string #\Newline))))
    (if (<= (js-length text) chars)
        text
        (let ((path (some (lambda (c) (getf (file-write-of c) :path)) calls)))
          (format nil "~a~%  ...[arguments of #~a clipped at ~d of ~d chars~a]" (js-slice text 0 chars) index chars (js-length text)
                  (if path (format nil "; query '#~a:~a:full'~a reads the file content" index path via) ""))))))

(defun render-entry (message &optional full index (detail-chars 4000) (via ""))
  "MESSAGE as recall shows it: (ROLE SUMMARY FILES), its one-line view, or with
FULL expand's view, a tool call's other arguments clipped at DETAIL-CHARS."
  (let ((role (json-get message "role"))
        (content (json-get message "content")))
    (flet ((clipped (max) (if full (text-of content) (js-clip (text-of content) max)))
           (maybe-clip (text max) (if full text (js-clip text max))))
      (cond ((equal role "user") (list "user" (clipped 300) nil))
            ((equal role "toolResult")
             (list "tool_result" (format nil "[~a] ~a" (js-string-of (json-get message "toolName")) (clipped 200)) nil))
            ((equal role "bashExecution")
             (list "bash" (maybe-clip (format nil "$ ~a~%~a" (or-empty (json-get message "command")) (or-empty (json-get message "output"))) 300) nil))
            ((equal role "pythonExecution")
             (list "python" (maybe-clip (format nil ">>> ~a~%~a" (or-empty (json-get message "code")) (or-empty (json-get message "output"))) 300) nil))
            ((equal role "fileMention")
             (let ((paths (file-mention-paths message)))
               (list "file" (join-strings (mapcar (lambda (p) (concatenate 'string "@" p)) paths) " ") paths)))
            ((member role '("developer" "custom") :test #'equal) (list role (clipped 300) nil))
            (t
             (let* ((text (clipped 300))
                    (calls (tool-calls-of message))
                    (tools (join-strings (mapcar #'call-line calls) ", "))
                    (files (mapcan (lambda (c) (copy-list (named-paths (call-args c)))) calls))
                    (args (if (and full (plusp (length tools))) (full-tool-args calls index detail-chars via) "")))
               (list "assistant"
                     (if (plusp (length tools))
                         (join-strings (remove "" (list tools args text) :test #'string=) (string #\Newline))
                         text)
                     files)))))))

(defparameter +tool-args-budget+ 2000
  "Characters of a message's tool-call arguments search indexes.")

(defun search-text (message)
  "MESSAGE's text as search reads it."
  (let ((role (json-get message "role")))
    (cond ((equal role "bashExecution")
           (format nil "~a ~a" (or-empty (json-get message "command")) (or-empty (json-get message "output"))))
          ((equal role "pythonExecution")
           (format nil "~a ~a" (or-empty (json-get message "code")) (or-empty (json-get message "output"))))
          ((equal role "fileMention") (join-strings (file-mention-paths message) " "))
          ((and (equal role "toolResult") (own-tool-p (json-get message "toolName") +recall-tool+)) "")
          (t
           (let* ((text (text-of (json-get message "content")))
                  (args (js-clip (join-strings (remove "" (mapcar (lambda (c) (args-text (call-args c)))
                                                                  (remove-if (lambda (c) (own-tool-p (call-name c) +recall-tool+))
                                                                             (tool-calls-of message)))
                                                       :test #'string=)
                                               (string #\Newline))
                                 +tool-args-budget+)))
             (if (plusp (length args)) (format nil "~a~%~a" text args) text))))))

;;; --- a session as recall reads it ------------------------------------------------

(defun read-session (path)
  "PATH's messages recall can show, as (INDEX ID MESSAGE), and its active branch
ids: the host's system message and unreadable entries left out (their `#N`
still taken), and what omp rewrote put back from the kept originals."
  (let* ((entries (jsonl-values path))
         (indexed (remove-if-not (lambda (m) (and (json-object-p (third m))
                                                  (not (equal (json-get (third m) "role") "system"))))
                                 (indexed-messages entries)))
         (wanted (make-hash-table :test 'equal)))
    (dolist (m indexed)
      (when (and (second m) (was-rewritten-p (third m))) (setf (gethash (second m) wanted) t)))
    (let ((kept (read-raw-store path wanted)))
      (values (loop for (index id message) in indexed
                    for restored = (multiple-value-bind (content found) (if id (gethash id kept) (values nil nil))
                                     (if found (with-original-content message content) message))
                    for readable = (ignore-errors (readable-message restored))
                    when readable collect (list index id readable))
              (active-branch-ids entries)))))
