;;;; search.lisp --- recall's ranking: BM25 over a session's entries.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/search-entries.ts, held to it number for number: the
;;;; same stopwords and stems, the same BM25 constants and order of operations
;;;; in double floats, the same relative floor and cap, the same snippets cut at
;;;; the same code units. tests/lisp-core.test.ts runs both on the same corpus
;;;; and compares every hit, snippet and count.
;;;;
;;;; What reaches it is each entry's role, text and files, the text as recall
;;;; reads it (search-entries.ts, rawSearchText); deciding what an entry's text
;;;; is stays with the code that reads the host's messages.
;;;;
;;;; Term queries only, for now. A query with a regex metacharacter is
;;;; answered :REGEX, and the caller runs it as before: JavaScript's regex
;;;; dialect is not ported yet.

(in-package #:omp-vcc)

(defparameter +stopwords+
  (let ((table (make-hash-table :test 'equal)))
    (dolist (w '("the" "a" "an" "is" "are" "was" "were" "be" "been" "being"
                 "have" "has" "had" "do" "does" "did" "will" "would" "could"
                 "should" "may" "might" "can" "shall" "of" "in" "to" "for"
                 "with" "on" "at" "from" "by" "as" "into" "through" "during"
                 "before" "after" "above" "below" "between" "out" "off" "over"
                 "under" "again" "further" "then" "once" "here" "there" "when"
                 "where" "why" "how" "all" "both" "each" "few" "more" "most"
                 "other" "some" "such" "no" "nor" "not" "only" "own" "same"
                 "so" "than" "too" "very" "just" "about" "it" "its" "that"
                 "this" "what" "which" "who" "whom" "these" "those")
                table)
      (setf (gethash w table) t)))
  "Words a term query drops: search-entries.ts's STOPWORDS.")

(defparameter +bm25-k+ 1.2d0)
(defparameter +bm25-b+ 0.75d0)
(defparameter +relative-floor+ 0.2d0
  "Multi-term hits scoring below this share of the top one are dropped; why 0.2 is in search-entries.ts.")
(defparameter +result-cap+ 50
  "Most hits a search returns; why 50 is in search-entries.ts.")
(defparameter +snippet-line-chars+ 300
  "Longest snippet line, in code units.")
(defparameter +base64-run+ 1000
  "A run of base64 characters this long can be encoded data.")
(defparameter +suffixes+
  '("ations" "ation" "ings" "ing" "ures" "ure" "ies" "ers" "er" "ed" "es" "ly" "s"))
(defparameter +min-stem+ 4)

(defun regex-metachar-p (char)
  (find char "|*+?{}()[]\\^$."))

(defun ascii-letter-p (char)
  (or (char<= #\a char #\z) (char<= #\A char #\Z)))

(defun stem-of (term)
  "The stem a plain ASCII word also matches at the start of a word, or NIL."
  (when (and (>= (js-length term) (1+ +min-stem+)) (every #'ascii-letter-p term))
    (let ((lower (string-downcase term)))
      (dolist (suffix +suffixes+)
        (let ((ls (length lower)) (lx (length suffix)))
          (when (and (> ls lx) (string= suffix lower :start2 (- ls lx)))
            (let ((stem (subseq lower 0 (- ls lx))))
              ;; "stopping" -> "stopp" -> "stop"
              (when (and (> (length stem) +min-stem+)
                         (char= (char stem (1- (length stem))) (char stem (- (length stem) 2))))
                (setf stem (subseq stem 0 (1- (length stem)))))
              (return (and (>= (length stem) +min-stem+) stem)))))))))

;;; --- one term, matched as search-entries.ts's `term|(?<![a-z])stem`/i --------

;;; Matching runs on folded text (FOLD): each character replaced by the one
;;; /i compares it as, so a case-insensitive match is a plain comparison of
;;; characters (FIND-TEXT). Folding maps character to character, so a position
;;; in the folded text is the same position in the original, and an ASCII
;;; letter folds to one, so the stem's look-behind reads the folded text as the
;;; original.
;;;
;;; Every pass over an entry's text is declared on TEXT, the one string type
;;; the core makes: untyped, a pass reads each character through SBCL's
;;; generic array access, and a search over 5,000 entries cost half a second.

(deftype text () '(simple-array character (*)))

(defun as-text (string)
  "STRING as a TEXT, copied only when it is some other kind of string."
  (if (typep string 'text) string (coerce string 'text)))

(defun fold (string)
  "STRING with every character as a non-unicode /i regex compares it."
  (let* ((s (as-text string)) (n (length s)) (out (make-string n)))
    (declare (text s out) (fixnum n) (optimize speed))
    (dotimes (i n out)
      (let* ((c (schar s i)) (code (char-code c)))
        (setf (schar out i) (cond ((< code 97) c)
                                  ((<= code 122) (code-char (- code 32)))
                                  ((< code 128) c)
                                  (t (js-canonical c))))))))

(defstruct (term (:constructor make-term
                     (text &aux (stem (stem-of text)) (word (fold text)) (folded-stem (and stem (fold stem))))))
  (text "" :type string)
  (stem nil)
  (word "" :type text)
  (folded-stem nil :type (or null text)))

(defun find-text (needle hay start)
  "The first position from START where NEEDLE occurs in HAY, or NIL."
  (declare (text needle hay) (fixnum start) (optimize speed))
  (let* ((m (length needle)) (last (- (length hay) m)))
    (declare (fixnum m last))
    (if (zerop m)
        (and (<= start (length hay)) start)
        (let ((first (schar needle 0)))
          (loop for p of-type fixnum from start to last
                when (and (char= (schar hay p) first)
                          (loop for k of-type fixnum from 1 below m
                                always (char= (schar hay (+ p k)) (schar needle k))))
                  return p)))))

(defun next-stem (stem hay start)
  "The first position from START where STEM occurs in HAY with no letter before it, or NIL."
  (declare (text stem hay) (fixnum start))
  (loop for p = (find-text stem hay start)
        while (and p (plusp p) (ascii-letter-p (schar hay (1- p))))
        do (setf start (1+ p))
        finally (return p)))

(defun next-match (term hay start)
  "The next match of TERM in the folded HAY from START, as (values POSITION LENGTH),
or NIL: the earliest position wins, and at one position the term itself before
its stem, as the alternation `term|(?<![a-z])stem` tries them."
  (declare (text hay) (fixnum start))
  (let ((word-at (find-text (term-word term) hay start))
        (stem-at (and (term-folded-stem term) (next-stem (term-folded-stem term) hay start))))
    (cond ((and word-at (or (null stem-at) (<= word-at stem-at))) (values word-at (length (term-word term))))
          (stem-at (values stem-at (length (term-folded-stem term)))))))

(defun term-frequency (term hay)
  "Non-overlapping matches of TERM in the folded HAY, as String.match with a global regex counts them."
  (loop with i = 0 and count = 0
        do (multiple-value-bind (at length) (next-match term hay i)
             (unless at (return count))
             (incf count)
             (setf i (+ at length)))))

(defun term-occurs-p (term hay)
  (and (next-match term hay 0) t))

(defun first-match (terms line)
  "The first position in the folded LINE where any of TERMS matches, or NIL."
  (let ((best nil))
    (dolist (term terms best)
      (let ((at (next-match term line 0)))
        (when (and at (or (null best) (< at best))) (setf best at))))))

;;; --- what an entry's text is to search ----------------------------------------

(declaim (inline base64-char-p))
(defun base64-char-p (char)
  (let ((code (char-code char)))
    (or (<= 65 code 90) (<= 97 code 122) (<= 48 code 57) (= code 43) (= code 47) (= code 61))))

(defun looks-encoded-p (text start end)
  "Encoded data mixes digits and both cases; joined identifiers, hex and rules do not."
  (declare (text text) (fixnum start end))
  (let ((digits 0) (upper 0) (lower 0) (n (- end start)))
    (declare (fixnum digits upper lower n))
    (loop for i from start below end
          for c = (schar text i)
          do (cond ((char<= #\0 c #\9) (incf digits))
                   ((char<= #\A c #\Z) (incf upper))
                   ((char<= #\a c #\z) (incf lower))))
    (and (>= digits (* n 0.05d0)) (>= upper (* n 0.15d0)) (>= lower (* n 0.15d0)))))

(defun encoded-runs (text)
  "The (START . END) of each run of TEXT that is encoded data."
  (declare (text text) (optimize speed))
  (let ((runs '()) (i 0) (n (length text)))
    (declare (fixnum i n))
    (loop while (< i n)
          do (if (base64-char-p (schar text i))
                 (let ((end i))
                   (declare (fixnum end))
                   (loop while (and (< end n) (base64-char-p (schar text end))) do (incf end))
                   (when (and (>= (- end i) +base64-run+) (looks-encoded-p text i end))
                     (push (cons i end) runs))
                   (setf i end))
                 (incf i)))
    (nreverse runs)))

(defun searchable-text (string)
  "STRING with each long run of encoded data replaced by an ellipsis."
  (let* ((text (as-text string)) (runs (encoded-runs text)))
    (if (null runs)
        text
        (as-text (with-output-to-string (out)
                   (let ((at 0))
                     (loop for (start . end) in runs
                           do (write-string text out :start at :end start)
                              (write-string "…" out)
                              (setf at end))
                     (write-string text out :start at)))))))

(defun word-count (text)
  "TEXT's word count as search-entries.ts counts it: split(/\\s+/).length."
  (declare (text text) (optimize speed))
  (let ((count 1) (in-space nil))
    (declare (fixnum count))
    (loop for c across text
          do (if (js-whitespace-p c)
                 (unless in-space (setf in-space t) (incf count))
                 (setf in-space nil)))
    count))

;;; --- snippets ----------------------------------------------------------------

(defun clip-line (line at)
  "LINE cut to a window of +SNIPPET-LINE-CHARS+ code units around unit AT."
  (let ((length (js-length line)) (width +snippet-line-chars+))
    (if (<= length width)
        line
        (let* ((start (max 0 (min (- at (/ width 2)) (- length width))))
               (end (+ start width)))
          (concatenate 'string (if (> start 0) "…" "") (js-slice line start end) (if (< end length) "…" ""))))))

(defun line-snippet (text folded terms &optional (context 2))
  "The lines around TEXT's first line that a term matches, or NIL. Matched
in the folded text, cut from the original at the same positions."
  (let* ((lines (coerce (split-string text #\Newline) 'vector))
         (folded (coerce (split-string folded #\Newline) 'vector))
         (count (length lines))
         (hit nil) (at 0))
    (loop for i below count
          for pos = (first-match terms (aref folded i))
          when pos do (setf hit i at (js-index (aref lines i) pos)) (return))
    (when hit
      (let* ((start (max 0 (- hit context)))
             (end (min count (+ hit context 1)))
             (parts '()))
        (when (> start 0) (push (format nil "...(~d lines above)" start) parts))
        (loop for i from start below end
              do (push (clip-line (aref lines i) (if (= i hit) at 0)) parts))
        (when (< end count) (push (format nil "...(~d lines below)" (- count end)) parts))
        (join-strings (nreverse parts) (string #\Newline))))))

;;; --- ranking -----------------------------------------------------------------

(defun meaningful-terms (raw)
  "RAW without stopwords and one-unit words; RAW itself when nothing is left."
  (or (remove-if (lambda (term)
                   (or (gethash (string-downcase term) +stopwords+) (<= (js-length term) 1)))
                 raw)
      raw))

(defun search-docs (query docs &key (floor +relative-floor+) (cap +result-cap+))
  "Rank DOCS, a vector of (ROLE TEXT FILES), for the term QUERY.
Returns the hits as a list of (INDEX . SNIPPET) best first, the count before
the cap, and whether the cap cut it; or :REGEX for a query this port leaves to
the TS side."
  (let ((raw-query (js-trim query)))
    (when (zerop (length raw-query))
      (return-from search-docs (values '() 0 nil)))
    (when (some #'regex-metachar-p raw-query)
      (return-from search-docs :regex))
    (let* ((terms (mapcar #'make-term (meaningful-terms (js-split-whitespace raw-query))))
           (n (length docs))
           (texts (map 'vector (lambda (d) (searchable-text (second d))) docs))
           (hays (map 'vector (lambda (d text)
                                (fold (concatenate 'text (first d) " " text " " (join-strings (third d) " "))))
                      docs texts))
           (lens (map 'vector #'word-count hays))
           (df (make-hash-table :test 'equal))
           (matched (make-array n))
           (total-length 0))
      ;; Document frequency counts each term object, as the TS map does: a
      ;; repeated term counts twice.
      (dotimes (i n)
        (incf total-length (aref lens i))
        (setf (aref matched i)
              (loop for term in terms
                    when (term-occurs-p term (aref hays i))
                      do (incf (gethash (term-text term) df 0))
                      and collect term)))
      (let ((avg-dl (/ (coerce total-length 'double-float) (max n 1)))
            (scored '()))
        (dotimes (i n)
          (let ((here (aref matched i)))
            (when here
              (let ((score 0d0) (dl (coerce (aref lens i) 'double-float)))
                (dolist (term here)
                  (let ((tf (coerce (term-frequency term (aref hays i)) 'double-float)))
                    (when (plusp tf)
                      (let* ((docfreq (gethash (term-text term) df 0))
                             (idf (log (+ (/ (+ (- n docfreq) 0.5d0) (+ docfreq 0.5d0)) 1d0)))
                             (norm (/ (* tf (+ +bm25-k+ 1d0))
                                      (+ tf (* +bm25-k+ (+ (- 1d0 +bm25-b+) (/ (* +bm25-b+ dl) avg-dl)))))))
                        (incf score (* idf norm))))))
                ;; The folded text is inside the folded hay, after the role and a space.
                (let* ((from (1+ (length (first (aref docs i)))))
                       (folded (subseq (aref hays i) from (+ from (length (aref texts i))))))
                  (push (list i score (line-snippet (aref texts i) folded terms)) scored))))))
        (setf scored (stable-sort (nreverse scored) #'> :key #'second))
        (let* ((distinct (length (remove-duplicates (mapcar (lambda (term) (string-downcase (term-text term))) terms)
                                                    :test #'string=)))
               (top (if scored (second (first scored)) 0d0))
               (kept (if (and (>= distinct 2) scored (> top 0d0))
                         (remove-if (lambda (s) (< (second s) (* top floor))) scored)
                         scored))
               (total (length kept))
               (hits (subseq kept 0 (min cap total))))
          (values (mapcar (lambda (s) (cons (first s) (third s))) hits)
                  total
                  (< (length hits) total)))))))
