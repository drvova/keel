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
;;;; omp rewrites messages in place; keel keeps their originals in
;;;; `<session>.jsonl.keel-raw` (raw-capture.lisp), and a message omp rewrote is read
;;;; with its original content put back, from this session's store or a parent's.

(in-package #:keel)

(defun read-file-octets (path)
  "PATH's bytes, or NIL when there is no such file."
  (with-open-file (in (native-path path) :element-type '(unsigned-byte 8) :if-does-not-exist nil)
    (when in
      (let ((bytes (make-array (file-length in) :element-type '(unsigned-byte 8))))
        (let ((n (read-sequence bytes in)))
          (if (= n (length bytes)) bytes (subseq bytes 0 n)))))))

(defun decode-utf-8 (bytes)
  "BYTES as text; a malformed sequence reads as U+FFFD, as Buffer.toString does."
  (sb-ext:octets-to-string bytes :external-format '(:utf-8 :replacement #\REPLACEMENT_CHARACTER)))

(defun native-path (path) (sb-ext:parse-native-namestring path))

(defun path-directory (path)
  "PATH's directory, as Node's dirname writes it: both separators
count, since a Windows path is written with `\` and a host's settings
may carry either."
  (let ((at (position-if (lambda (c) (or (char= c #\/) (char= c #\\))) path :from-end t)))
    (cond ((null at) ".")
          ((zerop at) (subseq path 0 1))
          (t (subseq path 0 at)))))

(defun path-separator (path)
  "The separator PATH is written with: `\` when it uses one, else `/`."
  (if (find #\\ path) #\\ #\/))

(defun join-path (dir name)
  "DIR and NAME joined with DIR's own separator, a trailing one not doubled."
  (concatenate 'string (string-right-trim "/\\" dir) (string (path-separator dir)) name))

(defun directory-files (dir)
  "DIR's files, as names, listed without SBCL's pathname syntax: a Windows
path handed to DIRECTORY comes back in a namestring with `/`, which then
matches no path written the way the host writes it."
  (let ((names '()) (seen (make-hash-table :test 'equal)))
    (dolist (pattern (list (merge-pathnames "*.*" (native-path (concatenate 'string dir "/")))))
      (ignore-errors
       (dolist (file (directory pattern))
         (let ((name (file-namestring file)))
           (unless (nth-value 1 (gethash name seen))
             (setf (gethash name seen) t) (push name names))))))
    (nreverse names)))

(defun parse-jsonl (text)
  "The JSON value of each line of TEXT that parses, in order."
  ;; Each line is parsed where it lies in the decoded text, not copied out first.
  (let ((values '()))
    (loop for start = 0 then (1+ end)
          for end = (or (position #\Newline text :start start) (length text))
          do (when (< start end)
               (handler-case (push (parse-json text :start start :end end) values)
                 (json-parse-error () nil)))
          while (< end (length text)))
    (nreverse values)))

(defparameter +jsonl-cached-files+ 8 "How many files' parsed lines a live core keeps.")
(defvar *jsonl-cache* '()
  "The files read last, newest first, as (PATH BYTES VALUES): a live core (live.lisp)
reads a session file again on every request, and parses only what changed.")

(defun same-octets-p (a b end)
  "A and B agree on their first END bytes."
  (declare (type (simple-array (unsigned-byte 8) (*)) a b) (type fixnum end) (optimize speed))
  (loop for i of-type fixnum from 0 below end always (= (aref a i) (aref b i))))

(defun jsonl-values (path)
  "The JSON value of each line of PATH that parses, in order; NIL when the file
does not exist (a new session's file is written with its first entry). The
values are shared with the next read of an unchanged file, so no caller
changes them (they copy, as COPY-OBJECT does); a file that only grew is parsed
from where it ended, at a line's end."
  (let* ((bytes (read-file-octets path))
         (cached (find path *jsonl-cache* :key #'first :test #'equal))
         (old (second cached)) (n (length old)))
    (setf *jsonl-cache* (remove cached *jsonl-cache*))
    (when bytes
      (let ((values (cond ((and cached (= n (length bytes)) (same-octets-p old bytes n)) (third cached))
                          ((and cached (plusp n) (> (length bytes) n) (= (aref old (1- n)) 10) (same-octets-p old bytes n))
                           (append (third cached) (parse-jsonl (decode-utf-8 (subseq bytes n)))))
                          (t (parse-jsonl (decode-utf-8 bytes))))))
        (push (list path bytes values) *jsonl-cache*)
        (when (> (length *jsonl-cache*) +jsonl-cached-files+) (setf *jsonl-cache* (subseq *jsonl-cache* 0 +jsonl-cached-files+)))
        (copy-list values)))))

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

(defun file-branch (path)
  "The entries on PATH's active branch, in file order."
  (let* ((entries (jsonl-values path)) (ids (active-branch-ids entries)))
    (coerce (remove-if-not (lambda (e) (and (hash-table-p e) (gethash (json-get e "id") ids))) entries) 'vector)))

;;; --- the header and the sessions a fork came from ------------------------------

(defparameter +header-bytes+ (* 64 1024))
(defparameter +max-parents+ 8 "How far up a fork's parents to follow.")

(defun read-header (path)
  "The header: the first `session` entry among the first lines of PATH."
  (ignore-errors
   (with-open-file (in (native-path path) :element-type '(unsigned-byte 8) :if-does-not-exist nil)
     (when in
       (let* ((bytes (make-array (min +header-bytes+ (file-length in)) :element-type '(unsigned-byte 8)))
              (n (read-sequence bytes in))
              (lines (split-string (decode-utf-8 (subseq bytes 0 n)) #\Newline)))
         (loop for line in (subseq lines 0 (min 8 (length lines)))
               for record = (parse-json-or-nil line)
               when (equal (json-get record "type") "session") return record))))))

(defparameter +short-id-chars+ 8 "A session id is named by this many characters or more.")

(defun short-id (id) "ID's first +SHORT-ID-CHARS+ characters, as a session is named to the agent." (subseq id 0 (min +short-id-chars+ (length id))))

(defun absolute-path-p (path)
  "Whether PATH is absolute, as Node's isAbsolute reads one on either system."
  (and (plusp (length path))
       (or (char= (char path 0) #\/) (char= (char path 0) #\\) (rx-test (rx "^[A-Za-z]:[\\\\/]") path))))

(defun parent-session-file (path)
  "The session PATH was forked or branched from, as a file: the header's
`parentSession`, a path, or a session id in the same directory (omp's files
are `<timestamp>_<id>.jsonl`)."
  (let ((parent (json-get (read-header path) "parentSession")))
    (when (and (stringp parent) (plusp (length parent)))
      (if (absolute-path-p parent)
          (and (probe-file (native-path parent)) parent)
          (let ((suffix (format nil "_~a.jsonl" parent)))
            (loop for name in (directory-files (path-directory path))
                  when (and (>= (length name) (length suffix))
                            (string= suffix name :start2 (- (length name) (length suffix))))
                    ;; The same form PATH is in, not a namestring DIRECTORY
                    ;; returns: lineage compares paths as strings, and the
                    ;; store is joined to them.
                    return (join-path (path-directory path) name)))))))

(defun session-lineage (path)
  "PATH and the sessions it was forked or branched from, nearest first."
  (let ((files (list path)))
    (loop for parent = (parent-session-file path) then (parent-session-file parent)
          while (and parent (<= (length files) +max-parents+) (not (member parent files :test #'string=)))
          do (setf files (append files (list parent))))
    files))

;;; --- the originals keel kept -------------------------------------------------

(defun raw-store-path (path) (concatenate 'string path +raw-store-suffix+))
(defun raw-store-paths (path)
  "Where PATH's originals are: its store, then the one keel kept as omp-vcc."
  (list (raw-store-path path) (concatenate 'string path +legacy-raw-store-suffix+)))

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
  (dolist (store (raw-store-paths path))
   (let ((bytes (ignore-errors (read-file-octets store))))
    (when bytes
      (dolist (line (split-string (decode-utf-8 bytes) #\Newline))
        (when (= (hash-table-count found) (hash-table-count wanted)) (return))
        (let ((id (and (plusp (length line)) (line-head-id line))))
          (when (and (stringp id) (gethash id wanted) (not (nth-value 1 (gethash id found))))
            (let ((record (parse-json-or-nil line)))
              (when (hash-table-p record)
                (setf (gethash id found) (json-get record "content")))))))))))

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

(defun restore-originals (messages ids file)
  "MESSAGES with the original content keel kept in FILE's raw store put back
where omp rewrote them (IDS parallel to MESSAGES)."
  (if (not (stringp file))
      messages
      (let ((wanted (make-hash-table :test 'equal)))
        (loop for m in messages for id in ids
              when (and (stringp id) (was-rewritten-p m)) do (setf (gethash id wanted) t))
        (if (zerop (hash-table-count wanted))
            messages
            (let ((kept (read-raw-store file wanted)))
              (loop for m in messages for id in ids
                    collect (multiple-value-bind (content found) (if (stringp id) (gethash id kept) (values nil nil))
                              (if found (with-original-content m content) m))))))))

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

(defun last-index-of-type (branch type &optional stop-at)
  "The index of the last entry of TYPE, -1 for none; with STOP-AT, -1 also when an entry of that type comes after it."
  (loop for i from (1- (length branch)) downto 0
        for ty = (json-get (aref branch i) "type")
        when (equal ty type) return i
        when (and stop-at (equal ty stop-at)) return -1
        finally (return -1)))

(defun last-reset-index (branch) (last-index-of-type branch +reset-entry-type+))

(defun last-compaction-index (branch) (last-index-of-type branch "compaction" +reset-entry-type+))

(defun live-window-start (branch)
  "The index of the first branch entry still in the model's context.
With no compaction, the whole branch (after omp's /clear). After one, its
firstKeptEntryId; when that is \"\" (a compact-all's sentinel) or no longer on
the branch, right after the compaction, or right after an omp native-replay
compaction's providerReplayThroughEntryId, where omp's own kept tail starts. A
reset_boundary (omp's /clear) after the latest compaction starts the window
after it, and one before it bounds where the kept id is looked for, as omp's
prepareCompaction does."
  (let ((reset (last-reset-index branch)) (compaction (last-compaction-index branch)))
    (if (< compaction 0)
        (1+ reset)
        (let ((c (aref branch compaction)))
          (flet ((find-after-reset (id)
                   (if (and (stringp id) (plusp (length id)))
                       (or (loop for i from (1+ reset) below (length branch)
                                 when (equal (json-get (aref branch i) "id") id) return i)
                           -1)
                       -1)))
            (let ((kept (find-after-reset (json-get c "firstKeptEntryId"))))
              (if (>= kept 0)
                  kept
                  (let ((replay (find-after-reset (json-get c "providerReplayThroughEntryId"))))
                    (if (and (>= replay 0) (< replay compaction)) (1+ replay) (1+ compaction))))))))))

(defun js-date-ms (v)
  "new Date(V).getTime() for the timestamps the hosts write (an ISO string or milliseconds), or NIL."
  (cond ((realp v) v)
        ((stringp v)
         (let ((m (rx-exec (rx "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,3})\\d*)?Z$") v)))
           (when m
             (flet ((g (i) (parse-integer (rx-group m i))))
               (+ (* 1000 (- (encode-universal-time (g 6) (g 5) (g 4) (g 3) (g 2) (g 1) 0) 2208988800))
                  (let ((ms (rx-group m 7))) (if ms (* (parse-integer ms) (expt 10 (- 3 (length ms)))) 0)))))))))

(defun live-message (entry)
  "A branch entry's message in the context, or NIL: a message entry's own; a
custom_message or a branch summary as the host's context builds it, with what
the host's convertToLlm reads of it (an extension's attribution and details)."
  (let ((type (json-get entry "type")))
    (cond ((and (equal type "message") (truthy-p (json-get entry "message"))) (json-get entry "message"))
          ((equal type "custom_message")
           (let ((m (json-object "role" "custom" "customType" (json-get entry "customType") "content" (json-get entry "content")
                                 "display" (json-get entry "display") "details" (json-get entry "details")
                                 "timestamp" (js-date-ms (json-get entry "timestamp")))))
             (multiple-value-bind (a present) (gethash "attribution" entry)
               (when present (setf (gethash "attribution" m) a)))
             m))
          ((equal type "branch_summary")
           (json-object "role" "branchSummary" "summary" (json-get entry "summary") "fromId" (json-get entry "fromId")
                        "timestamp" (js-date-ms (json-get entry "timestamp"))))
          (t nil))))
