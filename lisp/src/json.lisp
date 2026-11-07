;;;; json.lisp --- JSON in and out, with no value standing for another.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The common Lisp JSON libraries read false as NIL (the empty list too) and
;;;; null as a symbol that counts as true, so an empty list written back can
;;;; come out as false, and a null pass a check meant for a string. Here every
;;;; JSON value reads as exactly one Lisp value and writes back as itself:
;;;;
;;;;   object -> hash-table (EQUAL, string keys)   array -> simple-vector
;;;;   string -> string    integer -> integer    other number -> double-float
;;;;   true -> :TRUE    false -> :FALSE    null -> :NULL
;;;;
;;;; NIL is not a JSON value, and writing it is an error rather than a guess.
;;;;
;;;; Strings are JavaScript's: a \u escape of a lone surrogate reads as that
;;;; surrogate (SBCL characters can hold one), and one is written back as its
;;;; escape, so text the TS side sends survives the round trip unit for unit.

(in-package #:omp-vcc)

(define-condition json-parse-error (error)
  ((position :initarg :position :reader json-parse-error-position)
   (detail :initarg :detail :reader json-parse-error-detail))
  (:report (lambda (c s)
             (format s "JSON: ~a at character ~d"
                     (json-parse-error-detail c) (json-parse-error-position c)))))

;;; --- reading -----------------------------------------------------------------

(defun parse-json (text &key (start 0) end)
  "The one JSON value TEXT holds between START and END, with nothing but
whitespace around it."
  (let ((pos start) (n (or end (length text))))
    (labels ((fail (detail) (error 'json-parse-error :position pos :detail detail))
             (peek () (if (< pos n) (char text pos) (fail "unexpected end")))
             (skip-ws ()
               (loop while (and (< pos n) (member (char text pos) '(#\Space #\Tab #\Newline #\Return)))
                     do (incf pos)))
             (expect (c)
               (skip-ws)
               (unless (char= (peek) c) (fail (format nil "expected ~s" c)))
               (incf pos))
             (literal (word value)
               (unless (and (<= (+ pos (length word)) n) (string= word text :start2 pos :end2 (+ pos (length word))))
                 (fail "bad literal"))
               (incf pos (length word))
               value)
             (value ()
               (skip-ws)
               (case (peek)
                 (#\{ (object))
                 (#\[ (array))
                 (#\" (str))
                 (#\t (literal "true" :true))
                 (#\f (literal "false" :false))
                 (#\n (literal "null" :null))
                 (t (number))))
             (object ()
               (incf pos)
               (let ((table (make-hash-table :test 'equal)))
                 (skip-ws)
                 (if (char= (peek) #\})
                     (incf pos)
                     (loop (skip-ws)
                           (unless (char= (peek) #\") (fail "expected a key"))
                           (let ((key (str)))
                             (expect #\:)
                             (setf (gethash key table) (value)))
                           (skip-ws)
                           (case (peek)
                             (#\, (incf pos))
                             (#\} (incf pos) (return))
                             (t (fail "expected , or }")))))
                 table))
             (array ()
               (incf pos)
               (let ((items '()))
                 (skip-ws)
                 (if (char= (peek) #\])
                     (incf pos)
                     (loop (push (value) items)
                           (skip-ws)
                           (case (peek)
                             (#\, (incf pos))
                             (#\] (incf pos) (return))
                             (t (fail "expected , or ]")))))
                 (coerce (nreverse items) 'simple-vector)))
             (hex4 ()
               (when (> (+ pos 4) n) (fail "short \\u escape"))
               (prog1 (or (parse-integer text :start pos :end (+ pos 4) :radix 16 :junk-allowed nil)
                          (fail "bad \\u escape"))
                 (incf pos 4)))
             (str ()
               (incf pos)
               ;; Most strings hold no escape: copied out whole, not character by character.
               (let ((end (position-if (lambda (c) (or (char= c #\") (char= c #\\) (< (char-code c) 32))) text :start pos :end n)))
                 (when (and end (char= (char text end) #\"))
                   (return-from str (prog1 (subseq text pos end) (setf pos (1+ end))))))
               (with-output-to-string (out)
                 (loop (let ((c (peek)))
                         (incf pos)
                         (case c
                           (#\" (return))
                           (#\\ (let ((e (peek)))
                                  (incf pos)
                                  (case e
                                    (#\" (write-char #\" out)) (#\\ (write-char #\\ out)) (#\/ (write-char #\/ out))
                                    (#\b (write-char (code-char 8) out)) (#\f (write-char (code-char 12) out))
                                    (#\n (write-char #\Newline out)) (#\r (write-char (code-char 13) out))
                                    (#\t (write-char #\Tab out))
                                    (#\u (let ((code (hex4)))
                                           ;; A high surrogate followed by an escaped low one is one code point.
                                           (if (and (<= #xD800 code #xDBFF)
                                                    (< (+ pos 5) n)
                                                    (char= (char text pos) #\\) (char= (char text (1+ pos)) #\u))
                                               (let* ((save pos)
                                                      (low (progn (incf pos 2) (hex4))))
                                                 (if (<= #xDC00 low #xDFFF)
                                                     (write-char (code-char (+ #x10000 (ash (- code #xD800) 10) (- low #xDC00))) out)
                                                     (progn (setf pos save) (write-char (code-char code) out))))
                                               (write-char (code-char code) out))))
                                    (t (fail "bad escape")))))
                           (t (when (< (char-code c) 32) (fail "control character in string"))
                              (write-char c out)))))))
             (digits ()
               ;; One digit at least, as JSON.parse wants after a sign, a point or an exponent.
               (let ((from pos))
                 (loop while (and (< pos n) (digit-char-p (char text pos))) do (incf pos))
                 (when (= pos from) (fail "bad number"))))
             (number ()
               (let ((start pos))
                 (when (and (< pos n) (char= (char text pos) #\-)) (incf pos))
                 ;; No leading zero: "01" is not JSON.
                 (if (and (< pos n) (char= (char text pos) #\0))
                     (incf pos)
                     (digits))
                 (let ((fraction nil))
                   (when (and (< pos n) (char= (char text pos) #\.))
                     (setf fraction t) (incf pos) (digits))
                   (when (and (< pos n) (char-equal (char text pos) #\e))
                     (setf fraction t) (incf pos)
                     (when (and (< pos n) (find (char text pos) "+-")) (incf pos))
                     (digits))
                   (if fraction
                       (let ((*read-default-float-format* 'double-float))
                         ;; Only digits, sign, point and exponent reach the reader here.
                         (coerce (let ((*read-eval* nil)) (read-from-string text t nil :start start :end pos)) 'double-float))
                       ;; Past 2^53 JavaScript holds the nearest double, and so does this.
                       (let ((v (parse-integer text :start start :end pos)))
                         (if (> (abs v) +double-exact+) (coerce v 'double-float) v)))))))
      (prog1 (value)
        (skip-ws)
        (when (< pos n) (fail "trailing text"))))))

;;; --- writing -----------------------------------------------------------------


(defun parse-json-or-nil (text &key (start 0) end)
  "TEXT read as JSON, or NIL when it is not JSON: for a line a host or a crash
may have left half-written. Any other error is a bug, and is raised."
  (handler-case (parse-json text :start start :end end)
    (json-parse-error () nil)))

(defun write-json-string (string out)
  (write-char #\" out)
  (loop for c across string
        for code = (char-code c)
        do (case c
             (#\" (write-string "\\\"" out))
             (#\\ (write-string "\\\\" out))
             (#\Newline (write-string "\\n" out))
             (#\Tab (write-string "\\t" out))
             (t (cond ((= code 13) (write-string "\\r" out))
                      ((= code 8) (write-string "\\b" out))
                      ((= code 12) (write-string "\\f" out))
                      ((or (< code 32) (<= #xD800 code #xDFFF)) (format out "\\u~(~4,'0x~)" code))
                      (t (write-char c out))))))
  (write-char #\" out))

(defun write-json (value out)
  "Write VALUE as JSON to the stream OUT."
  (etypecase value
    (string (write-json-string value out))
    (hash-table
     ;; Keys in JavaScript's order, so the text is JSON.stringify's (a token
     ;; estimate counts its length).
     (write-char #\{ out)
     (loop for k in (json-keys value)
           for first = t then nil
           do (unless first (write-char #\, out))
              (write-json-string k out) (write-char #\: out) (write-json (gethash k value) out))
     (write-char #\} out))
    (vector
     (write-char #\[ out)
     (loop for i from 0 for v across value
           do (when (plusp i) (write-char #\, out)) (write-json v out))
     (write-char #\] out))
    ;; An integer past 2^53 as the double JavaScript would hold.
    (integer (if (<= (abs value) +double-exact+) (format out "~d" value) (write-string (js-number-string value) out)))
    (real (write-string (js-number-string value) out))
    ((member :true) (write-string "true" out))
    ((member :false) (write-string "false" out))
    ((member :null) (write-string "null" out))))

(defun json-string (value)
  "VALUE written as JSON text."
  (with-output-to-string (out) (write-json value out)))

(defun write-json-indented (value out depth)
  "VALUE as JSON.stringify(VALUE, null, 2) writes it, DEPTH levels in."
  (flet ((newline (d) (terpri out) (loop repeat (* 2 d) do (write-char #\Space out))))
    (cond ((and (hash-table-p value) (plusp (hash-table-count value)))
           (write-char #\{ out)
           (loop for k in (json-keys value) for first = t then nil
                 do (unless first (write-char #\, out))
                    (newline (1+ depth))
                    (write-json-string k out) (write-string ": " out)
                    (write-json-indented (gethash k value) out (1+ depth)))
           (newline depth) (write-char #\} out))
          ((and (vectorp value) (not (stringp value)) (plusp (length value)))
           (write-char #\[ out)
           (loop for v across value for first = t then nil
                 do (unless first (write-char #\, out))
                    (newline (1+ depth))
                    (write-json-indented v out (1+ depth)))
           (newline depth) (write-char #\] out))
          (t (write-json value out)))))

(defun json-pretty-string (value)
  "VALUE as JSON.stringify(VALUE, null, 2) writes it."
  (with-output-to-string (out) (write-json-indented value out 0)))

;;; --- objects -----------------------------------------------------------------

(defun json-object (&rest pairs)
  "A JSON object from alternating keys and values; a key whose value is NIL is left out."
  (let ((table (make-hash-table :test 'equal)))
    (loop for (k v) on pairs by #'cddr
          when v do (setf (gethash k table) v))
    table))

(defun json-get (object key &optional default)
  "KEY's value in the JSON OBJECT, or DEFAULT when OBJECT is no object or lacks KEY."
  (if (hash-table-p object)
      (multiple-value-bind (v found) (gethash key object)
        (if found v default))
      default))

(defun array-index-key-p (key)
  "True when KEY is a canonical array index, which JavaScript lists first."
  (and (plusp (length key))
       (every #'digit-char-p key)
       (or (string= key "0") (char/= (char key 0) #\0))
       (< (parse-integer key) 4294967295)))

(defun json-keys (object)
  "OBJECT's keys in JavaScript's order (Object.keys): array indices ascending,
then the rest in the order they were read. SBCL's hash tables keep insertion
order (test/json.lisp pins it)."
  (let ((indices '()) (names '()))
    (maphash (lambda (k v) (declare (ignore v))
               (if (array-index-key-p k) (push k indices) (push k names)))
             object)
    (append (sort indices #'< :key #'parse-integer) (nreverse names))))

(defun json-values (object)
  "OBJECT's values in the order of JSON-KEYS."
  (mapcar (lambda (k) (gethash k object)) (json-keys object)))
