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

(declaim (inline astral-p))
(defun astral-p (char)
  "True when CHAR takes two UTF-16 code units (a surrogate pair)."
  (> (char-code char) #xFFFF))

(defun js-length (string)
  "STRING's length in UTF-16 code units: JavaScript's .length."
  (loop for c across string sum (if (astral-p c) 2 1)))

(defun js-slice (string start &optional end)
  "STRING from code unit START below code unit END, as JavaScript's slice
with non-negative bounds. A pair cut in half leaves its lone surrogate, as
JavaScript's does."
  (let* ((length (js-length string))
         (end (min (or end length) length))
         (start (min (max start 0) end))
         (unit 0))
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

(defun js-canonical (char)
  "CHAR as a non-unicode /i regex compares it: its uppercase when that is
one character and does not take a non-ASCII character to ASCII. Code points
past the BMP are compared as their code units, which no case maps."
  (if (astral-p char)
      char
      (let ((upper (char-upcase char)))
        (if (and (>= (char-code char) 128) (< (char-code upper) 128)) char upper))))

(defun js-char-equal (a b)
  "True when A and B are the same character under a non-unicode /i regex."
  (char= (js-canonical a) (js-canonical b)))

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
