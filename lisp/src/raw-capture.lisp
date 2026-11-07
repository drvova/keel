;;;; raw-capture.lisp --- keeping the originals of what omp rewrites, as they land.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Between compactions omp keeps the live context small by rewriting messages
;;;; in place and persisting the rewrite: it blanks old tool output, supersedes
;;;; older reads, elides results their tool flagged useless, and shakes tool
;;;; output and large fenced blocks out into `artifact://` files. vcc_recall
;;;; reads the session file as the raw history, so each rewrite would lose what
;;;; it replaced. omp-vcc copies every message omp may rewrite as it lands into
;;;; `<session>.jsonl.vcc-raw` beside it (not a `.jsonl`: omp lists those as
;;;; sessions), and points omp's placeholders at the copy; session.lisp reads
;;;; the store. What a binding has seen and kept is its own state, in
;;;; src/hooks/raw-capture.ts: the core gets the entries that arrived since,
;;;; appends the store itself, and on a new session file reads the ids the
;;;; file's lineage already keeps.

(in-package #:omp-vcc)

(defparameter +shakeable-text-chars+ 1200
  "omp shakes fenced and XML blocks of 400+ tokens out of a message's text: about this many chars.")
(defparameter +max-kept-chars+ 1000000
  "One message's kept text is clipped here, so a stray multi-megabyte result cannot double the session's size alone.")

(defun text-part-p (p) (and (equal (json-get p "type") "text") (stringp (json-get p "text"))))

(defun may-be-rewritten-p (m)
  "Whether omp may rewrite M: tool output, or text long enough to hold a block omp shakes."
  (when (and (truthy-p m) (not (and (hash-table-p m) (nth-value 1 (gethash "prunedAt" m)))))
    (let ((role (json-get m "role")) (content (json-get m "content")))
      (cond ((equal role "toolResult")
             (plusp (if (stringp content)
                        (js-length content)
                        (loop for p in (object-parts content) when (text-part-p p) sum (js-length (json-get p "text"))))))
            ((member role '("assistant" "user" "developer") :test #'equal)
             (if (stringp content)
                 (>= (js-length content) +shakeable-text-chars+)
                 (some (lambda (p) (and (text-part-p p) (>= (js-length (json-get p "text")) +shakeable-text-chars+)))
                       (object-parts content))))))))

(defun kept-content (content)
  "What the store keeps of CONTENT: the text (clipped), other parts as they are, images without their data."
  (let ((budget +max-kept-chars+))
    (flet ((clip (text)
             (let ((n (js-length text)))
               (if (<= n budget)
                   (progn (decf budget n) text)
                   (prog1 (format nil "~a~%...[omp-vcc kept the first ~d of ~d chars]" (js-slice text 0 budget) budget n)
                     (setf budget 0))))))
      (if (stringp content)
          (clip content)
          (coerce (loop for p in (object-parts content)
                        collect (cond ((text-part-p p)
                                       (let ((copy (copy-object p))) (setf (gethash "text" copy) (clip (json-get p "text"))) copy))
                                      ((equal (json-get p "type") "image") (copy-object p "data"))
                                      (t p)))
                  'vector)))))

(defun store-ids (path ids)
  "The ids PATH's store keeps, into the set IDS: the id at each line's head (a line that does not read is passed over)."
  (let ((bytes (ignore-errors (read-file-octets (raw-store-path path)))))
    (when bytes
      (dolist (line (split-string (decode-utf-8 bytes) #\Newline))
        (let ((id (and (plusp (length line)) (line-head-id line))))
          (when (stringp id) (setf (gethash id ids) t)))))
    ids))

(defun lineage-kept-ids (file)
  "The ids FILE's store and its parents' stores hold."
  (let ((ids (make-hash-table :test 'equal)))
    (dolist (f (session-lineage file) ids) (store-ids f ids))))

(defun append-raw-store (file records)
  "Append RECORDS to FILE's store, one line per record, `id` first. NIL when the write fails."
  (or (null records)
      (ignore-errors
       (with-open-file (out (sb-ext:parse-native-namestring (raw-store-path file)) :direction :output :if-exists :append
                                                                                   :if-does-not-exist :create :external-format :utf-8)
         (dolist (r records) (write-json r out) (terpri out))
         t))))

(defun capture-entries (input)
  "Keep the originals of the entries that arrived since the last call:
(values WRITTEN-IDS OK LINEAGE-IDS). KEPT are those of them the binding keeps
already; with LINEAGE, the store ids of the file's lineage are read too (a new
session file) and returned."
  (let* ((file (json-get input "file"))
         (kept (make-hash-table :test 'equal))
         (lineage (and (eq (json-get input "lineage") :true) (lineage-kept-ids file))))
    (loop for id across (json-get input "kept" #()) do (setf (gethash id kept) t))
    (when lineage (maphash (lambda (k v) (setf (gethash k kept) v)) lineage))
    (let ((records (loop for e across (json-get input "entries" #())
                         for id = (json-get e "id")
                         when (and (equal (json-get e "type") "message") (stringp id) (not (gethash id kept))
                                   (may-be-rewritten-p (json-get e "message")))
                           collect (json-object "id" id "content" (kept-content (json-get (json-get e "message") "content"))))))
      (values (mapcar (lambda (r) (json-get r "id")) records)
              (append-raw-store file records)
              (and lineage (loop for k being the hash-keys of lineage collect k))))))

;;; --- pointers on omp's placeholders --------------------------------------------------

(defun point-placeholders (input)
  "For each candidate tool result whose text is
one of omp's placeholders and whose original is kept, its new text, as (I TEXT)."
  (let ((hits (loop for c across (json-get input "candidates" #())
                    when (rx-test (rx "^\\[(?:Output truncated - \\d+ tokens|Superseded by a newer read of this file|Uneventful result elided)\\]$")
                                  (json-get c "text"))
                      collect c))
        (kept (make-hash-table :test 'equal)))
    (loop for id across (json-get input "kept" #()) do (setf (gethash id kept) t))
    (when (and hits (plusp (hash-table-count kept)))
      (let ((by-call (make-hash-table :test 'equal))
            (index (index-by-id (coerce (json-get input "entries" #()) 'vector))))
        ;; The tool result each call id names on the active path (a reused id: the latest).
        (loop for r across (json-get input "branch" #())
              do (setf (gethash (json-get r "toolCallId") by-call) (json-get r "id")))
        (loop for h in hits
              for id = (gethash (json-get h "callId") by-call)
              for n = (and (stringp id) (plusp (length id)) (gethash id index))
              when (and n (gethash id kept))
                collect (json-object "i" (json-get h "i")
                                     "text" (format nil "~a (the original: ~a)" (json-get h "text") (recall-expand-call n))))))))
