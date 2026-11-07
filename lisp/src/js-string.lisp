;;;; js-string.lisp --- strings measured and cut as JavaScript does.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A Lisp string holds code points; a JavaScript string holds UTF-16 code
;;;; units, and an emoji is one character here and two there. Every number the
;;;; TS side and this core exchange (a budget, a clip, an offset into a line)
;;;; and every size limit omp-vcc states is in code units, and a limit must
;;;; stay the same number on a ~128K window whichever side computes it. So
;;;; text is measured and cut here only through JS-LENGTH and JS-SLICE.
;;;;
;;;; The same goes for what JavaScript calls whitespace (\s, String.trim) and
;;;; how /i compares characters: each is JavaScript's definition, written out,
;;;; not the nearest Lisp predicate.

(in-package #:omp-vcc)

(defconstant +double-exact+ (expt 2 53) "Integers up to this a double holds exactly: past it JavaScript's numbers skip.")
(defconstant +max-safe-integer+ (1- (expt 2 53)) "Number.MAX_SAFE_INTEGER.")

(declaim (inline astral-p))
(defun astral-p (char)
  "True when CHAR takes two UTF-16 code units (a surrogate pair)."
  (> (char-code char) #xFFFF))

(defun js-length (string)
  "STRING's length in UTF-16 code units: JavaScript's .length."
  (if (typep string '(simple-array character (*)))
      (let ((n (length string)))
        (declare (type (simple-array character (*)) string) (fixnum n) (optimize speed))
        (loop for c across string count (> (char-code c) #xFFFF) into astral
              finally (return (+ n astral))))
      (loop for c across string sum (if (astral-p c) 2 1))))

(defun js-slice (string start &optional end)
  "STRING from code unit START below code unit END, as JavaScript's slice
with non-negative bounds. A pair cut in half leaves its lone surrogate, as
JavaScript's does."
  (let* ((length (js-length string))
         (end (min (or end length) length))
         (start (min (max start 0) end))
         (unit 0))
    ;; Without a character past the BMP, a code unit is a character.
    (when (= length (length string))
      (return-from js-slice (subseq string start end)))
    (with-output-to-string (out)
      (loop for c across string
            while (< unit end)
            do (if (astral-p c)
                   (let* ((v (- (char-code c) #x10000))
                          (high (+ #xD800 (ash v -10)))
                          (low (+ #xDC00 (logand v #x3FF))))
                     (cond ((and (>= unit start) (<= (+ unit 2) end)) (write-char c out))
                           (t (when (and (>= unit start) (< unit end)) (write-char (code-char high) out))
                              (when (and (>= (1+ unit) start) (< (1+ unit) end)) (write-char (code-char low) out))))
                     (incf unit 2))
                   (progn (when (>= unit start) (write-char c out))
                          (incf unit)))))))

(defun js-index (string position)
  "The code unit offset of character POSITION of STRING."
  (loop for i below position sum (if (astral-p (char string i)) 2 1)))

(declaim (inline js-whitespace-p))
(defun js-whitespace-p (char)
  "True for JavaScript's \\s and String.trim set: WhiteSpace and LineTerminator."
  (let ((code (char-code char)))
    (or (<= 9 code 13) (= code 32) (= code #xA0) (= code #x1680)
        (<= #x2000 code #x200A) (= code #x2028) (= code #x2029)
        (= code #x202F) (= code #x205F) (= code #x3000) (= code #xFEFF))))

(defun js-trim (string)
  "STRING without leading and trailing JavaScript whitespace."
  (string-trim-if #'js-whitespace-p string))

(defun string-trim-if (predicate string)
  (let ((start (position-if-not predicate string))
        (end (position-if-not predicate string :from-end t)))
    (if start (subseq string start (1+ end)) "")))

(defun js-split-whitespace (string)
  "STRING split as JavaScript's split(/\\s+/): an edge run of whitespace
leaves an empty string at that edge, and \"\" splits into (\"\")."
  (let ((parts '()) (start 0) (i 0) (n (length string)))
    (loop while (< i n)
          do (if (js-whitespace-p (char string i))
                 (let ((run-end (or (position-if-not #'js-whitespace-p string :start i) n)))
                   (push (subseq string start i) parts)
                   (setf start run-end i run-end))
                 (incf i)))
    (push (subseq string start) parts)
    (nreverse parts)))


;;; --- Canonicalize --------------------------------------------------------------
;;;
;;; How a non-unicode /i regex compares characters (the spec's Canonicalize):
;;; a code unit's uppercase when that is one code unit and does not take a
;;; non-ASCII character to ASCII, from SBCL's full Unicode case mapping, the
;;; one toUpperCase uses. Both the regex engine and the term search fold by it.---------------------------------------------------------

(defun canonical-unit (unit)
  (let ((upper (sb-unicode:uppercase (string (code-char unit)))))
    (if (/= (length upper) 1)
        unit
        (let ((u (char-code (char upper 0))))
          (if (or (> u #xFFFF) (and (>= unit 128) (< u 128))) unit u)))))

(defparameter +canonical+
  (let ((table (make-array 65536 :element-type '(unsigned-byte 16))))
    (dotimes (u 65536 table)
      (setf (aref table u) (if (<= #xD800 u #xDFFF) u (canonical-unit u)))))
  "Each code unit as a non-unicode /i regex compares it.")

(defparameter +same-case+
  (let ((by-canonical (make-hash-table)))
    (dotimes (u 65536) (push u (gethash (aref +canonical+ u) by-canonical)))
    (let ((table (make-array 65536 :initial-element nil)))
      (maphash (lambda (canonical units)
                 (declare (ignore canonical))
                 (when (rest units) (dolist (u units) (setf (aref table u) units))))
               by-canonical)
      table))
  "For a code unit that /i makes equal to others, all of them; NIL for one equal only to itself.")

(declaim (inline canon))
(defun canon (unit) (aref (the (simple-array (unsigned-byte 16) (*)) +canonical+) unit))

(defun js-canonical (char)
  "CHAR as a non-unicode /i regex compares it (+CANONICAL+). Code points past
the BMP are compared as their code units, which no case maps."
  (if (astral-p char) char (code-char (canon (char-code char)))))

(defun split-string (string char)
  "STRING split at every CHAR, empty parts kept: JavaScript's split(CHAR)."
  (loop with start = 0
        for pos = (position char string :start start)
        collect (subseq string start pos)
        while pos
        do (setf start (1+ pos))))

(defun join-strings (strings separator)
  "STRINGS joined with SEPARATOR between them."
  (with-output-to-string (out)
    (loop for (s . rest) on strings
          do (write-string s out)
             (when rest (write-string separator out)))))

(defun js-code-unit (string unit)
  "The UTF-16 code unit at UNIT of STRING, or NIL past its end."
  (let ((u 0))
    (loop for c across string
          for code = (char-code c)
          do (if (> code #xFFFF)
                 (let ((v (- code #x10000)))
                   (cond ((= u unit) (return (+ #xD800 (ash v -10))))
                         ((= (1+ u) unit) (return (+ #xDC00 (logand v #x3FF)))))
                   (incf u 2))
                 (progn (when (= u unit) (return code))
                        (incf u))))))

(defun js-last-space (string limit)
  "The code unit offset of the last space at or before LIMIT, or -1: lastIndexOf(\" \", LIMIT)."
  (let ((u 0) (found -1))
    (loop for c across string
          while (<= u limit)
          do (when (char= c #\Space) (setf found u))
             (incf u (if (> (char-code c) #xFFFF) 2 1)))
    found))

(defun js-clip (text &optional (max 200))
  "TEXT cut to MAX code units at a space past 60% of MAX when there is one,
never between the halves of a pair."
  (let ((length (js-length text)))
    (if (<= length max)
        text
        (let* ((cut (js-last-space text max))
               (end (if (> cut (* max 0.6d0)) cut max)))
          (when (and (> end 0) (< end length))
            (let ((code (js-code-unit text (1- end))))
              (when (and code (<= #xD800 code #xDBFF)) (decf end))))
          (js-slice text 0 end)))))

(defun js-number-string (x)
  "The number X as JavaScript's String() writes it (Number::toString): the
shortest digits that read back as the double, in plain notation from 1e-6 up to
1e21 and in exponent notation outside it."
  (if (and (integerp x) (<= (abs x) +double-exact+))
      (format nil "~d" x)
      (let ((d (coerce x 'double-float)))
        (if (zerop d)
            "0"
            (multiple-value-bind (n digits) (sb-impl::flonum-to-digits (abs d))
              (let* ((k (length digits))
                     (sign (if (minusp d) "-" ""))
                     (zeros (lambda (m) (make-string m :initial-element #\0)))
                     (body (cond ((<= k n 21) (concatenate 'string digits (funcall zeros (- n k))))
                                 ((< 0 n 22) (concatenate 'string (subseq digits 0 n) "." (subseq digits n)))
                                 ((< -6 n 1) (concatenate 'string "0." (funcall zeros (- n)) digits))
                                 (t (let ((e (1- n)))
                                      (concatenate 'string (subseq digits 0 1)
                                                   (if (> k 1) (concatenate 'string "." (subseq digits 1)) "")
                                                   (if (>= e 0) "e+" "e-") (format nil "~d" (abs e))))))))
                (concatenate 'string sign body)))))))

(defun js-string-of (value)
  "VALUE (a JSON value, or NIL for undefined) as JavaScript's String() or a
template literal writes it."
  (cond ((null value) "undefined")
        ((stringp value) value)
        ((eq value :null) "null")
        ((eq value :true) "true")
        ((eq value :false) "false")
        ((realp value) (js-number-string value))
        ((hash-table-p value) "[object Object]")
        ((vectorp value)
         (join-strings (map 'list (lambda (v) (if (or (null v) (eq v :null)) "" (js-string-of v))) value) ","))
        (t (princ-to-string value))))
