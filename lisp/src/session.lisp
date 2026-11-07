;;;; session.lisp --- a session file as omp and Pi write it.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Recall's reading of a session file, with the raw store beside it. JSONL,
;;;; one entry per line; the first `session` entry is the header; every other
;;;; entry has an `id` and a `parentId`, so the entries form a tree and the
;;;; active branch is the last entry back to the root. `#N` numbers the message
;;;; entries in file order, every branch included: it is what summaries cite and
;;;; recall resolves, so the summary's count (INDEX-BY-ID over the host's
;;;; snapshot, host.lisp) and recall's (over the file) are the one count here.
;;;;
;;;; omp rewrites messages in place; omp-vcc keeps their originals in
;;;; `<session>.jsonl.vcc-raw` (raw-capture.lisp), and a message omp rewrote is read
;;;; with its original content put back, from this session's store or a parent's.

(in-package #:omp-vcc)

(defun read-file-octets (path)
  "PATH's bytes, or NIL when there is no such file."
  (with-open-file (in path :element-type '(unsigned-byte 8) :if-does-not-exist nil)
    (when in
      (let ((bytes (make-array (file-length in) :element-type '(unsigned-byte 8))))
        (let ((n (read-sequence bytes in)))
          (if (= n (length bytes)) bytes (subseq bytes 0 n)))))))

(defun decode-utf-8 (bytes)
  "BYTES as text; a malformed sequence reads as U+FFFD, as Buffer.toString does."
  (sb-ext:octets-to-string bytes :external-format '(:utf-8 :replacement #\REPLACEMENT_CHARACTER)))

(defun jsonl-values (path)
  "The JSON value of each line of PATH that parses, in order; NIL when the file
does not exist (a new session's file is written with its first entry)."
  (let ((bytes (read-file-octets path)))
    (when bytes
      ;; Each line is parsed where it lies in the decoded file, not copied out first.
      (let ((text (decode-utf-8 bytes)) (values '()))
        (loop for start = 0 then (1+ end)
              for end = (or (position #\Newline text :start start) (length text))
              do (when (< start end)
                   (handler-case (push (parse-json text :start start :end end) values)
                     (json-parse-error () nil)))
              while (< end (length text)))
        (nreverse values)))))

(defun entry-type (entry) (json-get entry "type"))

(defun counted-entry-p (entry)
  "An entry `#N` counts: a persisted message."
  (and (equal (entry-type entry) "message")
       (let ((m (json-get entry "message" :null))) (not (eq m :null)))))

(defun line-holds-message-p (line)
  "COUNTED-ENTRY-P on a message entry's raw LINE, without parsing it: the first
`\"message\":` is the entry's own key (the hosts write it after the head), and
it holds an object, not null. Session listings count #N this way."
  (let ((at (search "\"message\":" line)))
    (and at (let ((next (position-if-not (lambda (c) (member c '(#\Space #\Tab))) line :start (+ at 10))))
              (and next (char= (char line next) #\{))))))

(defun indexed-messages (entries)
  "Each message entry as (INDEX ID MESSAGE), INDEX its `#N`."
  (let ((n -1))
    (loop for entry in entries
          when (counted-entry-p entry)
            collect (list (incf n)
                          (let ((id (json-get entry "id"))) (and (stringp id) id))
                          (json-get entry "message")))))

(defun index-by-id (entries)
  "#N by entry id over ENTRIES (a vector, in file order); an id seen twice is left out, so a ref is missing rather than wrong."
  (let ((by-id (make-hash-table :test 'equal)) (ambiguous (make-hash-table :test 'equal)) (n 0))
    (loop for e across entries
          when (counted-entry-p e)
            do (let ((id (json-get e "id")))
                 (when (and (stringp id) (plusp (length id)))
                   (if (or (nth-value 1 (gethash id by-id)) (gethash id ambiguous))
                       (progn (remhash id by-id) (setf (gethash id ambiguous) t))
                       (setf (gethash id by-id) n))))
                 (incf n))
    by-id))

(defun in-tree-p (type)
  "Entries the tree is made of: everything but the header and omp's title slot."
  (not (member type '("session" "title") :test #'equal)))

(defun walk-to-root (parent-of last)
  "The ids from LAST back to the root through PARENT-OF (id -> parent id), as an EQUAL hash set."
  (let ((ids (make-hash-table :test 'equal)))
    (loop for id = last then (gethash id parent-of)
          while (and id (not (gethash id ids)))
          do (setf (gethash id ids) t))
    ids))

(defun active-branch-ids (entries)
  "The ids on the active branch, the last entry back to the root, as an EQUAL
hash set; empty for a file without ids (an old format)."
  (let ((parent-of (make-hash-table :test 'equal)) (last nil))
    (dolist (e entries)
      (let ((id (json-get e "id")))
        (when (and (hash-table-p e) (in-tree-p (entry-type e)) (stringp id))
          (setf (gethash id parent-of) (let ((p (json-get e "parentId"))) (and (stringp p) p))
                last id))))
    (walk-to-root parent-of last)))

;;; --- the header and the sessions a fork came from ------------------------------

(defparameter +header-bytes+ (* 64 1024))
(defparameter +max-parents+ 8 "How far up a fork's parents to follow.")

(defun read-header (path)
  "The header: the first `session` entry among the first lines of PATH."
  (ignore-errors
   (with-open-file (in path :element-type '(unsigned-byte 8) :if-does-not-exist nil)
     (when in
       (let* ((bytes (make-array (min +header-bytes+ (file-length in)) :element-type '(unsigned-byte 8)))
              (n (read-sequence bytes in))
              (lines (split-string (decode-utf-8 (subseq bytes 0 n)) #\Newline)))
         (loop for line in (subseq lines 0 (min 8 (length lines)))
               for record = (parse-json-or-nil line)
               when (equal (json-get record "type") "session") return record))))))

(defun parent-session-file (path)
  "The session PATH was forked or branched from, as a file: the header's
`parentSession`, a path, or a session id in the same directory (omp's files
are `<timestamp>_<id>.jsonl`)."
  (let ((parent (json-get (read-header path) "parentSession")))
    (when (and (stringp parent) (plusp (length parent)))
      ;; An absolute path, as Node's isAbsolute reads one on either system.
      (if (or (char= (char parent 0) #\/) (char= (char parent 0) #\\)
              (rx-test (rx "^[A-Za-z]:[\\\\/]") parent))
          (and (probe-file parent) parent)
          (let ((suffix (format nil "_~a.jsonl" parent)))
            (loop for file in (ignore-errors (directory (merge-pathnames "*.jsonl" (directory-namestring path))))
                  for name = (file-namestring file)
                  when (and (>= (length name) (length suffix))
                            (string= suffix name :start2 (- (length name) (length suffix))))
                    return (namestring file)))))))

(defun session-lineage (path)
  "PATH and the sessions it was forked or branched from, nearest first."
  (let ((files (list path)))
    (loop for parent = (parent-session-file path) then (parent-session-file parent)
          while (and parent (<= (length files) +max-parents+) (not (member parent files :test #'string=)))
          do (setf files (append files (list parent))))
    files))

;;; --- the originals omp-vcc kept -------------------------------------------------

(defun raw-store-path (path) (concatenate 'string path +raw-store-suffix+))

(defun line-head-id (line)
  "The id a raw-store line starts with (`{\"id\":\"...\"`), or NIL."
  (let ((prefix "{\"id\":\""))
    (when (and (> (length line) (length prefix)) (string= prefix line :end2 (length prefix)))
      (let ((end (loop with i = (length prefix)
                       while (< i (min (length line) 512))
                       do (case (char line i)
                            (#\\ (incf i 2))
                            (#\" (return i))
                            (t (incf i))))))
        (when end
          (parse-json-or-nil (subseq line (1- (length prefix)) (1+ end))))))))

(defun read-one-store (path wanted found)
  (let ((bytes (ignore-errors (read-file-octets (raw-store-path path)))))
    (when bytes
      (dolist (line (split-string (decode-utf-8 bytes) #\Newline))
        (when (= (hash-table-count found) (hash-table-count wanted)) (return))
        (let ((id (and (plusp (length line)) (line-head-id line))))
          (when (and (stringp id) (gethash id wanted) (not (nth-value 1 (gethash id found))))
            (let ((record (parse-json-or-nil line)))
              (when (hash-table-p record)
                (setf (gethash id found) (json-get record "content"))))))))))

(defun read-raw-store (path wanted)
  "The kept content of the WANTED ids, the first copy of each, from PATH's store
and then its parents': a fork carries its parent's entries as they were when
it forked, and their originals are in the parent's store."
  (let ((found (make-hash-table :test 'equal)))
    (when (plusp (hash-table-count wanted))
      (read-one-store path wanted found)
      (when (< (hash-table-count found) (hash-table-count wanted))
        (dolist (parent (rest (session-lineage path)))
          (read-one-store parent wanted found)
          (when (= (hash-table-count found) (hash-table-count wanted)) (return)))))
    found))

(defun object-parts (content)
  "The object parts of a content array, in order."
  (and (json-array-p content) (remove-if-not #'hash-table-p (coerce content 'list))))

(defun was-rewritten-p (message)
  "omp rewrote MESSAGE in the session file: a tool result it blanked or shook
carries `prunedAt`; a text block it shook points at an `artifact://`."
  (when (hash-table-p message)
    (or (nth-value 1 (gethash "prunedAt" message))
        (and (not (equal (json-get message "role") "toolResult"))
             (let ((content (json-get message "content")))
               (some (lambda (text) (search "artifact://" text))
                     (if (stringp content)
                         (list content)
                         (loop for p in (object-parts content)
                               when (equal (json-get p "type") "text")
                                 collect (let ((tx (json-get p "text")))
                                           (cond ((stringp tx) tx)
                                                 ((or (null tx) (eq tx :null)) "")
                                                 (t (js-string-of tx))))))))))))

(defun with-original-content (message kept)
  "MESSAGE with what omp rewrote put back: a tool result takes the kept content
whole; another message takes back each text block that changed. A record with
no content (KEPT NIL) leaves MESSAGE as it is."
  (let ((content (json-get message "content")))
    (cond ((null kept) message)
          ((or (equal (json-get message "role") "toolResult") (stringp kept) (stringp content))
           (let ((copy (copy-object message "prunedAt")))
             (setf (gethash "content" copy) kept)
             copy))
          (t
           (let ((kept-parts (coerce (object-parts kept) 'vector))
                 (copy (copy-object message)))
             (setf (gethash "content" copy)
                   (coerce (loop for p in (object-parts content)
                                 for i from 0
                                 for k = (and (< i (length kept-parts)) (aref kept-parts i))
                                 collect (if (and (equal (json-get p "type") "text") k
                                                  (equal (json-get k "type") "text")
                                                  (not (equal (json-get k "text") (json-get p "text"))))
                                             (let ((part (copy-object p)))
                                               (setf (gethash "text" part) (json-get k "text"))
                                               part)
                                             p))
                           'vector))
             copy)))))
