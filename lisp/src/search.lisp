;;;; search.lisp --- recall's ranking: BM25 over a session's entries.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Ported from the TypeScript search it replaced, number for number: BM25 in
;;;; double floats, stems, stopwords, a relative floor and a cap, snippets cut
;;;; at JavaScript's code units. tests/search.test.ts drives it through recall.
;;;;
;;;; What reaches it is each entry's role, text and files, the text as recall
;;;; reads it (render.lisp); deciding what an entry's text is stays there.
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
  "Words a term query drops.")

(defparameter +bm25-k+ 1.2d0)
(defparameter +bm25-b+ 0.75d0)
;;; The floor applies only to a query of two or more distinct terms ("auth auth"
;;; is one): a single term's score differences are term frequency and document
;;; length, not the OR-tail noise the floor is for. Measured with
;;; scripts/benchmark-recall-quality.ts on real sessions (two runs, 161 and 222
;;; queries): 0.20 cut the multi-term median from 49 to 23 hits and from 60.5 to
;;; 23.5, with no zero-hit query and no top-1 change, and the top 5 changed in 7%
;;; and 5% of queries; 0.10 barely thinned the tail (median 49 to 39), and 0.25
;;; doubled the top-5 changes for little more. The top hit always survives: its
;;; own score is at least floor times itself.
(defparameter +relative-floor+ 0.2d0
  "Multi-term hits scoring below this share of the top one are dropped.")
;;; Uncapped, the same queries returned up to 380 hits (median 32 and 29.5, p90
;;; 119 and 115.9). 50 is above the median and below the p90: 29% and 30% of
;;; queries were clipped, against 56% at 25, and the worst case shrinks by 87%.
;;; With the floor: the median went from 32 to 18 and 29.5 to 20, p90 to 50, and
;;; the top 5 changed in 3% and 2% of queries.
(defparameter +result-cap+ 50
  "Most hits a search returns, by terms or by a regex alike.")
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
                     (text &aux (stem (stem-of text)) (word (fold text)) (folded-stem (and stem (fold stem)))
                                ;; A term with a metacharacter is a regex (safeRegex); a plain
                                ;; one is matched by FIND-TEXT, which is the same answer faster.
                                (regex (and (some #'regex-metachar-p text) (safe-regex text))))))
  (text "" :type string)
  (stem nil)
  (word "" :type text)
  (folded-stem nil :type (or null text))
  (regex nil))

(defstruct (hay (:constructor make-hay (original &aux (folded (fold original)))))
  "A text as search matches it: folded for plain terms, as code units for a regex (made when first asked for)."
  (original "" :type string)
  (folded "" :type text)
  (units-cache nil))

(defun hay-units (hay)
  (or (hay-units-cache hay) (setf (hay-units-cache hay) (string-units (hay-original hay)))))

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
  "Non-overlapping matches of TERM in HAY, as String.match with a global regex counts them."
  (if (term-regex term)
      (regex-count (term-regex term) (hay-units hay))
      (loop with i = 0 and count = 0 and folded = (hay-folded hay)
            do (multiple-value-bind (at length) (next-match term folded i)
                 (unless at (return count))
                 (incf count)
                 (setf i (+ at length))))))

(defun term-occurs-p (term hay)
  (if (term-regex term)
      (regex-test (term-regex term) (hay-units hay))
      (and (next-match term (hay-folded hay) 0) t)))

(defun term-position (term line)
  "The code unit where TERM first matches in the hay LINE, or NIL."
  (if (term-regex term)
      (values (regex-search (term-regex term) (hay-units line)))
      (let ((at (next-match term (hay-folded line) 0)))
        (and at (js-index (hay-original line) at)))))

(defun first-match (terms line)
  "The first code unit in the hay LINE where any of TERMS matches, or NIL: where
the terms joined by | match first, as search-entries.ts's snippet regex does."
  (let ((best nil))
    (dolist (term terms best)
      (let ((at (term-position term line)))
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

(defun line-snippet (text terms &optional (context 2))
  "The lines around TEXT's first line that a term matches, or NIL. TERMS is a
list of terms, or a regex (the regex path's one pattern)."
  (let* ((lines (coerce (split-string text #\Newline) 'vector))
         (count (length lines))
         (hit nil) (at 0))
    (loop for i below count
          for pos = (if (regex-p terms)
                        (values (regex-search terms (string-units (aref lines i))))
                        (first-match terms (make-hay (aref lines i))))
          when pos do (setf hit i at pos) (return))
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

(defparameter +search-budget-ms+ 3000
  "A search's time budget: search-entries.ts SEARCH_BUDGET_MS.")

(defparameter +search-aborted+
  (format nil "Search aborted: query exceeded ~dms. Use fewer or more specific words; for a regex, avoid nested quantifiers such as (a+)+."
          +search-budget-ms+)
  "What an aborted search says: search-entries.ts SearchAborted.")

(defun search-docs (query docs &key (floor +relative-floor+) (cap +result-cap+))
  "Rank DOCS, a vector of (ROLE TEXT FILES), for QUERY, as search-entries.ts
search does. Returns the hits as a list of (INDEX . SNIPPET) best first, the
count before the cap, and whether the cap cut it; or (values :ABORTED MESSAGE)
past the time budget or the control stack."
  (let ((*regex-deadline* (+ (get-internal-real-time)
                             (* +search-budget-ms+ (/ internal-time-units-per-second 1000))))
        (*steps* 0))
    (handler-case (search-docs-within query docs floor cap)
      ;; A regex too deep for the stack is one too costly to search, as one past the budget is.
      ((or regex-aborted storage-condition) () (values :aborted +search-aborted+)))))

(defun cap-hits (hits cap)
  (let ((total (length hits)))
    (values (subseq hits 0 (min cap total)) total (> total cap))))

(defun search-docs-within (query docs floor cap)
  (let ((raw-query (js-trim query)))
    (when (zerop (length raw-query))
      (return-from search-docs-within (values '() 0 nil)))
    (let* ((n (length docs))
           (texts (map 'vector (lambda (d) (searchable-text (second d))) docs))
           (hays (map 'vector (lambda (d text)
                                (make-hay (concatenate 'text (first d) " " text " " (join-strings (third d) " "))))
                      docs texts)))
      ;; A query with a metacharacter is first one regex, its hits in entry order
      ;; and unranked; when it finds nothing, the query is searched as terms.
      (when (some #'regex-metachar-p raw-query)
        (let ((regex (safe-regex raw-query)))
          (let ((hits (loop for i below n
                            when (regex-test regex (hay-units (aref hays i)))
                              collect (cons i (line-snippet (aref texts i) regex)))))
            (when hits (return-from search-docs-within (cap-hits hits cap))))))
      (search-terms raw-query texts hays floor cap))))

(defun search-terms (raw-query texts hays floor cap)
  "The term search: BM25 over HAYS for RAW-QUERY's meaningful words."
  (let* ((terms (mapcar #'make-term (meaningful-terms (js-split-whitespace raw-query))))
         (n (length hays)))
    (let* ((lens (map 'vector (lambda (h) (word-count (hay-folded h))) hays))
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
