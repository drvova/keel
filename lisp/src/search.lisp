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

(defstruct (term (:constructor make-term (text &aux (stem (stem-of text)))))
  (text "" :type string)
  (stem nil))

(defun literal-at-p (needle text pos)
  (and (<= (+ pos (length needle)) (length text))
       (loop for i below (length needle)
             always (js-char-equal (char needle i) (char text (+ pos i))))))

(defun term-match-length (term text pos)
  "Length of TERM's match starting at POS of TEXT, or NIL: the term itself
first, then its stem where no letter precedes it, as the alternation tries them."
  (let ((word (term-text term)) (stem (term-stem term)))
    (cond ((literal-at-p word text pos) (length word))
          ((and stem
                (or (zerop pos) (not (ascii-letter-p (char text (1- pos)))))
                (literal-at-p stem text pos))
           (length stem)))))

(defun term-frequency (term text)
  "Non-overlapping matches of TERM in TEXT, as String.match with a global regex counts them."
  (loop with i = 0 and n = (length text) and count = 0
        while (< i n)
        do (let ((len (term-match-length term text i)))
             (if len (progn (incf count) (incf i len)) (incf i)))
        finally (return count)))

(defun term-occurs-p (term text)
  (loop for i below (length text) thereis (term-match-length term text i)))

(defun first-match (terms line)
  "The first position in LINE where any of TERMS matches, or NIL."
  (loop for i below (length line)
        when (some (lambda (term) (term-match-length term line i)) terms)
          return i))

;;; --- what an entry's text is to search ----------------------------------------

(defun base64-char-p (char)
  (or (ascii-letter-p char) (char<= #\0 char #\9) (find char "+/=")))

(defun looks-encoded-p (run)
  "Encoded data mixes digits and both cases; joined identifiers, hex and rules do not."
  (let ((digits 0) (upper 0) (lower 0) (n (length run)))
    (loop for c across run
          do (cond ((char<= #\0 c #\9) (incf digits))
                   ((char<= #\A c #\Z) (incf upper))
                   ((char<= #\a c #\z) (incf lower))))
    (and (>= digits (* n 0.05d0)) (>= upper (* n 0.15d0)) (>= lower (* n 0.15d0)))))

(defun searchable-text (text)
  "TEXT with each long run of encoded data replaced by an ellipsis."
  (with-output-to-string (out)
    (loop with i = 0 and n = (length text)
          while (< i n)
          do (if (base64-char-p (char text i))
                 (let* ((end (or (position-if-not #'base64-char-p text :start i) n))
                        (run (subseq text i end)))
                   (write-string (if (and (>= (length run) +base64-run+) (looks-encoded-p run)) "…" run) out)
                   (setf i end))
                 (progn (write-char (char text i) out) (incf i))))))

;;; --- snippets ----------------------------------------------------------------

(defun clip-line (line at)
  "LINE cut to a window of +SNIPPET-LINE-CHARS+ code units around unit AT."
  (let ((length (js-length line)) (width +snippet-line-chars+))
    (if (<= length width)
        line
        (let* ((start (max 0 (min (- at (/ width 2)) (- length width))))
               (end (+ start width)))
          (concatenate 'string (if (> start 0) "…" "") (js-slice line start end) (if (< end length) "…" ""))))))

(defun line-snippet (text terms &optional (context 2))
  "The lines around TEXT's first line that a term matches, or NIL."
  (let* ((lines (coerce (split-string text #\Newline) 'vector))
         (count (length lines))
         (hit nil) (at 0))
    (loop for i below count
          for pos = (first-match terms (aref lines i))
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
                                (format nil "~a ~a ~a" (first d) text (join-strings (third d) " ")))
                      docs texts))
           (lens (map 'vector (lambda (h) (length (js-split-whitespace h))) hays))
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
                (push (list i score (line-snippet (aref texts i) terms)) scored)))))
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
