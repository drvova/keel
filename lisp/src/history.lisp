;;;; history.lisp --- [History Index]: one line per range of compacted #N.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Each compaction adds the range it summarizes: its #N, how many requests
;;;; and the longest of them, the files changed, the commits and the failed
;;;; calls. The ranges are stored in details.historyIndex and merged at the
;;;; next compaction, the two closest merged while there are more than the
;;;; budget allows, so the index stays bounded however long the session runs
;;;; and still points recall at every stretch of it.

(in-package #:keel)

(defparameter +range-asks+ 4 "The longest requests a range keeps.")
(defparameter +range-files+ 24 "The changed files a range keeps; a range at the cap says `24+`.")
(defparameter +range-commits+ 4 "The latest commits a range keeps.")

(defstruct (range (:constructor make-range (from to requests asks files commits commit-count failed)))
  "FROM and TO the first and last #N; REQUESTS the user requests in it, NIL for a
range from before the index existed; ASKS the longest, longest first; FILES
changed, first seen first; COMMITS \"hash subject\", oldest first, of COMMIT-COUNT;
FAILED the calls whose result was an error."
  from to requests asks files commits commit-count failed)

(defun range-json (r)
  (json-object "from" (range-from r) "to" (range-to r) "requests" (range-requests r)
               "asks" (coerce (range-asks r) 'vector) "files" (coerce (range-files r) 'vector)
               "commits" (coerce (range-commits r) 'vector)
               "commitCount" (range-commit-count r) "failed" (range-failed r)))

(defun range-from-json (r)
  "A stored range, or NIL when R is not a well-formed one."
  (when (and (json-object-p r)
             (js-integer-p (json-get r "from")) (js-integer-p (json-get r "to")) (<= (json-get r "from") (json-get r "to"))
             (every (lambda (k) (json-array-p (json-get r k))) '("asks" "files" "commits"))
             (js-integer-p (json-get r "commitCount")) (js-integer-p (json-get r "failed"))
             (multiple-value-bind (q present) (gethash "requests" r) (or (not present) (js-integer-p q))))
    (make-range (as-integer (json-get r "from")) (as-integer (json-get r "to"))
                (let ((q (json-get r "requests"))) (and q (as-integer q)))
                (strings-of (json-get r "asks")) (coerce (json-get r "files") 'list) (strings-of (json-get r "commits"))
                (as-integer (json-get r "commitCount")) (as-integer (json-get r "failed")))))

(defun read-history-index (index)
  "A stored index (details.historyIndex) as a list of ranges, or :INVALID when it is not a well-formed one."
  (let ((ranges (and (json-array-p index) (map 'list #'range-from-json index))))
    (if (and (json-array-p index) (notany #'null ranges)) ranges :invalid)))

(defun longest-first (asks)
  (let* ((unique (remove-duplicates asks :test #'string= :from-end t))
         (sorted (stable-sort (copy-list unique) #'> :key #'js-length)))
    (subseq sorted 0 (min +range-asks+ (length sorted)))))

(defun first-n (list n) (subseq list 0 (min n (length list))))

(defun range-of-window (messages indices)
  "The range this compaction summarizes, or NIL when it has no #N."
  (let ((known (remove-if-not #'realp (coerce indices 'list))))
    (when known
      (let* ((blocks (summary-blocks messages indices))
             (changed (multiple-value-bind (read modified created) (extract-files blocks nil)
                        (declare (ignore read))
                        (remove-duplicates (append modified created) :test #'string= :from-end t)))
             (commits (mapcar (lambda (c) (js-clip (if (commit-hash c) (format nil "~a ~a" (commit-hash c) (commit-message c)) (commit-message c)) 45))
                              (extract-commits blocks)))
             (asks (extract-user-messages blocks)))
        (make-range (reduce #'min known) (reduce #'max known) (length asks)
                    (mapcar (lambda (a) (js-clip a 80)) (longest-first asks))
                    (first-n changed +range-files+)
                    (last-n commits +range-commits+)
                    (length commits)
                    (count-if (lambda (b) (and (eq (block-kind b) :tool-call) (block-failed b))) blocks))))))

(defun merge-two-ranges (a b)
  (make-range (min (range-from a) (range-from b)) (max (range-to a) (range-to b))
              (and (range-requests a) (range-requests b) (+ (range-requests a) (range-requests b)))
              (longest-first (append (range-asks a) (range-asks b)))
              (first-n (remove-duplicates (append (range-files a) (range-files b)) :test #'equal :from-end t) +range-files+)
              (last-n (append (range-commits a) (range-commits b)) +range-commits+)
              (+ (range-commit-count a) (range-commit-count b))
              (+ (range-failed a) (range-failed b))))

(defun says-nothing-p (r)
  (and (eql (range-requests r) 0) (null (range-files r)) (zerop (range-commit-count r)) (zerop (range-failed r))))

(defun merge-history-index (previous fresh max-ranges)
  "PREVIOUS with FRESH added: a FRESH that says nothing and follows the last range
extends it; past MAX-RANGES (at least 2) the two neighbours spanning least are
merged, never the newest range, which stays on its own as the latest work."
  (let* ((ranges (copy-list previous)) (last (car (last ranges))))
    (if (and fresh last (says-nothing-p fresh) (<= (range-from fresh) (1+ (range-to last))) (> (range-to fresh) (range-to last)))
        (let ((extended (copy-range last))) (setf (range-to extended) (range-to fresh))
          (append (butlast ranges) (list extended)))
        (progn
          (when fresh (setf ranges (append ranges (list fresh))))
          (setf ranges (stable-sort ranges #'< :key #'range-from))
          (loop while (> (length ranges) (max 2 max-ranges))
                do (let ((best 0) (best-span nil) (v (coerce ranges 'vector)))
                     (loop for i from 0 below (- (length v) 2)
                           for span = (- (range-to (aref v (1+ i))) (range-from (aref v i)))
                           when (or (null best-span) (< span best-span)) do (setf best i best-span span))
                     (setf ranges (append (subseq ranges 0 best) (list (merge-two-ranges (aref v best) (aref v (1+ best)))) (nthcdr (+ best 2) ranges)))))
          ranges))))

(defun unindexed-range (to)
  "What came before the index existed: #0 to TO, which only recall can say more about."
  (make-range 0 to nil '() '() '() 0 0))

;;; --- the lines ------------------------------------------------------------------

(defun plural (n one) (format nil "~d ~a~a" n one (if (= n 1) "" "s")))

(defun history-files (files)
  (if (<= (length files) 3)
      (format nil "changed ~a" (join-strings (mapcar (lambda (p) (join-strings (last (split-string p #\/) 2) "/")) files) ", "))
      (let* ((dirs (remove-duplicates (mapcar (lambda (p) (let ((parts (remove "" (split-string p #\/) :test #'string=)))
                                                            (if (> (length parts) 1) (nth (- (length parts) 2) parts) ".")))
                                              files)
                                      :test #'string= :from-end t)))
        (format nil "changed ~a files in ~a~a" (if (>= (length files) +range-files+) (format nil "~d+" (length files)) (length files))
                (join-strings (first-n dirs 6) ", ") (if (> (length dirs) 6) ", …" "")))))

(defun range-work (r)
  "What a range did, as phrases: the files it changed, its commits, its failed calls."
  (let ((parts '()) (files (remove-if-not #'stringp (range-files r)))
        (commits (range-commits r)) (count (range-commit-count r)) (failed (range-failed r)))
    (when files (push (history-files files) parts))
    (when (> count 0)
      ;; A range read from an older index may count commits it does not list.
      (let ((last (car (last commits))))
        (push (cond ((= count 1) (format nil "1 commit~@[: ~a~]" last))
                    (t (format nil "~d commits~@[, last ~a~]" count last)))
              parts)))
    (when (> failed 0) (push (plural failed "failed call") parts))
    (nreverse parts)))

(defun history-line (r)
  "One [History Index] line: `#FROM–#TO: what happened in it`."
  (let ((parts '()) (requests (range-requests r)))
    (cond ((null requests) (push "earlier, not indexed; search it with keel_recall" parts))
          ((> requests 0)
           (push (format nil "~a: ~a" (plural requests "request")
                         (join-strings (mapcar (lambda (a) (format nil "\"~a\"" a)) (first-n (range-asks r) 1)) ", "))
                 parts)))
    (setf parts (append (nreverse parts) (range-work r)))
    (format nil "#~d–#~d~:[~;: ~a~]" (range-from r) (range-to r) parts (join-strings parts " · "))))
