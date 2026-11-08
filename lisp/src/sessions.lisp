;;;; sessions.lisp --- the project's other sessions, for cross-session recall.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The files themselves, newest first by last write and the current one left
;;;; out, come from the TS side (src/host.ts, projectFiles): listing a
;;;; directory by modification time to the millisecond is the host's, and SBCL
;;;; reads it to the second. Everything else (headers, ids and their short forms,
;;;; each file's scan by line heads, its pins on its active branch) is here.

(in-package #:keel)

(defstruct (session-info (:constructor make-session-info (file short started bytes messages title first-request pins)))
  file short started bytes messages title first-request pins)

(defun short-ids (ids)
  "The shortest prefix (dashes left out) of 8 characters or more that names each id alone."
  (let* ((keys (mapcar (lambda (id) (remove #\- id)) ids))
         (lower (mapcar #'string-downcase keys)))
    (loop for key in keys for i from 0
          collect (let ((n +short-id-chars+))
                    (loop while (and (< n (length key))
                                     (loop for k in lower for j from 0
                                           thereis (and (/= j i) (starts-with (subseq (nth i lower) 0 n) k))))
                          do (incf n))
                    (subseq key 0 (min n (length key)))))))

(defun project-ids (files)
  "FILES (newest first) with their header ids and shorts, as (FILE ID SHORT)."
  (let* ((found (loop for f in files
                      for id = (json-get (read-header f) "id")
                      when (stringp id) collect (list f id)))
         (shorts (short-ids (mapcar #'second found))))
    (mapcar (lambda (s short) (list (first s) (second s) short)) found shorts)))

(defun utf-8-head (line limit)
  "LINE's first LIMIT bytes of UTF-8 as Buffer.toString reads them: a character cut in half is U+FFFD."
  (let ((bytes 0))
    (with-output-to-string (out)
      (loop for c across line
            for n = (let ((code (char-code c))) (cond ((< code #x80) 1) ((< code #x800) 2) ((< code #x10000) 3) (t 4)))
            do (cond ((<= (+ bytes n) limit) (write-char c out) (incf bytes n))
                     (t (when (< bytes limit) (write-char #\REPLACEMENT_CHARACTER out)) (return)))))))

(defun entry-head (line)
  "(values TYPE ID PARENT PARENT-PRESENT) read from the line's head, without parsing the line."
  (let* ((head (utf-8-head line 400))
         (type (let ((m (rx-exec (rx "^\\{\"type\":\"([^\"]+)\"") head))) (and m (rx-group m 1))))
         (id (let ((m (rx-exec (rx "\"id\":\"([^\"]+)\"") head))) (and m (rx-group m 1))))
         (parent (rx-exec (rx "\"parentId\":(?:\"([^\"]+)\"|null)") head)))
    (values type id (and parent (rx-group parent 1)) (and parent t))))

(defun name-of (e)
  (let ((name (cond ((member (json-get e "type") '("title" "title_change") :test #'equal) (json-get e "title"))
                    ((equal (json-get e "type") "session_info") (json-get e "name")))))
    (and (stringp name) (plusp (length (js-trim name))) (js-trim name))))

(defun scan-session (file short)
  "One pass over a session file: header, messages, first request, title, pins on its active branch."
  (let ((bytes (ignore-errors (read-file-octets file))) (header (read-header file)))
    (when (and bytes (stringp (json-get header "id")))
      (let ((title nil) (first-request nil) (messages 0) (pin-entries '())
            (parent-of (make-hash-table :test 'equal)) (last nil))
        (dolist (line (split-string (decode-utf-8 bytes) #\Newline))
          (when (plusp (length line))
            (multiple-value-bind (type id parent) (entry-head line)
              (when (and (in-tree-p type) id) (setf (gethash id parent-of) parent last id))
              (cond ((equal type "message")
                     (when (line-holds-message-p line) (incf messages))
                     (when (and (null first-request) (search "\"role\":\"user\"" line))
                       (let ((words (request-words (json-get (parse-json-or-nil line) "message"))))
                         (when (plusp (length words)) (setf first-request (js-clip words 100))))))
                    (t (let ((e (parse-json-or-nil line)))
                         (if (or (pin-entry-p e) (equal (json-get e "type") +reset-entry-type+))
                             (push e pin-entries)
                             (setf title (or (name-of e) title)))))))))
        (let* ((branch (walk-to-root parent-of last))
               (pins (reverse pin-entries))
               (on-branch (if (plusp (hash-table-count branch))
                              (remove-if-not (lambda (e) (and (stringp (json-get e "id")) (gethash (json-get e "id") branch))) pins)
                              pins)))
          (make-session-info file short
                             (let ((ts (json-get header "timestamp"))) (and (stringp ts) ts))
                             (length bytes) messages
                             (and title (js-clip title 80)) first-request
                             (mapcar #'format-pin (read-pins (coerce on-branch 'vector)))))))))

(defun list-project-sessions (files)
  "The project's other sessions, the newest 50, and whether there are older ones."
  (let ((ids (project-ids files)))
    (values (remove nil (mapcar (lambda (s) (scan-session (first s) (third s))) (subseq ids 0 (min +max-listed-sessions+ (length ids)))))
            (> (length ids) +max-listed-sessions+))))

(defun resolve-session (ref sessions)
  "The one of SESSIONS ((FILE ID SHORT)) an id prefix names, or (:error TEXT)."
  (let ((key (string-downcase (remove #\- ref))))
    (if (< (length key) +session-ref-min-chars+)
        (list :error (format nil "session:'~a' is too short: give at least ~d characters of an id from mode:'sessions'." ref +session-ref-min-chars+))
        (let ((matches (remove-if-not (lambda (s) (starts-with key (string-downcase (remove #\- (second s))))) sessions)))
          (cond ((= (length matches) 1) (first matches))
                ((null matches) (list :error (format nil "No earlier session of this project starts with '~a'. mode:'sessions' lists them." ref)))
                (t (list :error (format nil "session:'~a' matches ~d sessions (~a): give more of the id." ref (length matches)
                                        (join-strings (mapcar #'third matches) ", ")))))))))

(defun find-session (files ref)
  (let ((found (resolve-session ref (project-ids files))))
    (if (eq (first found) :error)
        found
        (or (scan-session (first found) (third found)) (list :error (format nil "Session ~a could not be read." (third found)))))))

(defun describe-session (s)
  (format nil "~a · ~a · ~d messages~@[ · ~a~]~@[ · \"~a\"~]"
          (session-info-short s)
          (let ((iso (session-info-started s))) (if iso (js-slice (substitute #\Space #\T iso :count 1) 0 16) "unknown start"))
          (session-info-messages s) (session-info-title s) (session-info-first-request s)))
