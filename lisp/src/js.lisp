;;;; js.lisp --- JavaScript's reading of JSON values, for the code that reads the hosts' JSON.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; What the hosts write is JavaScript's: a field may be absent, null, false,
;;;; 0 or "" where the code means "none", an array is a vector (and a string is
;;;; a vector too, to Lisp), and a number may be an integer written as a float.
;;;; These read them the one way, for every module.

(in-package #:keel)

(defun json-array-p (v)
  "A JSON array: a vector that is not a string."
  (and (vectorp v) (not (stringp v))))

(defun truthy-p (v)
  "JavaScript's truthiness of a JSON value: absent, null, false, 0 and \"\" are false."
  (and v (not (member v '(:null :false 0 "") :test #'equal))))

(defun bool (x) (if x :true :false))

(defun js-integer-p (v) (or (integerp v) (and (floatp v) (= v (ftruncate v)))))

(defun as-integer (v) (if (integerp v) v (truncate v)))

(defun strings-of (v)
  "The strings of the JSON array V, in order; none when V is not an array."
  (if (json-array-p v) (remove-if-not #'stringp (coerce v 'list)) '()))

(defun or-empty (v)
  "A field as a template literal writes `${v ?? \"\"}`: \"\" for null or absent."
  (if (or (null v) (eq v :null)) "" (js-string-of v)))

(defun unset-p (v)
  "A value sent empty: absent, null, a blank string or an empty array."
  (or (null v) (eq v :null)
      (and (stringp v) (zerop (length (js-trim v))))
      (and (json-array-p v) (zerop (length v)))))

(defun copy-object (table &optional without)
  "A copy of the JSON object TABLE, its keys in their order, the key WITHOUT left out."
  (let ((copy (make-hash-table :test 'equal)))
    (dolist (k (json-keys table) copy)
      (unless (equal k without) (setf (gethash k copy) (gethash k table))))))

(defun last-n (list n)
  "LIST's last N items, as Array.slice(-N) gives them (all of it for N 0)."
  (if (or (<= n 0) (>= n (length list))) list (last list n)))

(defun nl () (string #\Newline))

(defun json-object-p (v) (hash-table-p v))

(defun string-or (v default) (if (stringp v) v default))

(defun js-number-text (s)
  "Number() of the trimmed string S: a decimal literal, or a 0x, 0o or 0b integer; NIL
for NaN and for a value past a double's range (Infinity, which no caller can use).
An integral value is an integer, as JSON.parse gives one; any other a double."
  (let ((n (length s)) (i 0))
    (labels ((digits (radix)
               (let ((start i))
                 (loop while (and (< i n) (digit-char-p (char s i) radix)) do (incf i))
                 (and (> i start) (parse-integer s :start start :end i :radix radix))))
             (finish (r)
               (cond ((integerp r) (if (< (abs r) +double-exact+) r (finish-double r)))
                     (t (finish-double r))))
             (finish-double (r)
               (and (< (abs r) most-positive-double-float) (coerce r 'double-float))))
      (cond ((zerop n) 0)
            ((and (> n 2) (char= (char s 0) #\0) (find (char s 1) "xXoObB"))
             (setf i 2)
             (let ((v (digits (ecase (char-downcase (char s 1)) (#\x 16) (#\o 8) (#\b 2)))))
               (and v (= i n) (finish v))))
            (t
             (let ((sign 1) (int nil) (frac 0) (frac-digits 0) (exp 0))
               (when (find (char s 0) "+-") (when (char= (char s 0) #\-) (setf sign -1)) (incf i))
               (setf int (digits 10))
               (when (and (< i n) (char= (char s i) #\.))
                 (incf i)
                 (let ((start i) (f (digits 10)))
                   (when f (setf frac f frac-digits (- i start)))))
               (when (and (null int) (zerop frac-digits)) (return-from js-number-text nil))
               (when (and (< i n) (char-equal (char s i) #\e))
                 (incf i)
                 (let ((esign 1))
                   (when (and (< i n) (find (char s i) "+-")) (when (char= (char s i) #\-) (setf esign -1)) (incf i))
                   (let ((e (digits 10)))
                     (unless e (return-from js-number-text nil))
                     ;; Past these a double is 0 or Infinity whatever the digits.
                     (when (> e 400)
                       (return-from js-number-text (if (and (= esign 1) (or (and int (plusp int)) (plusp frac))) nil 0)))
                     (setf exp (* esign e)))))
               (and (= i n)
                    (finish (* sign (+ (or int 0) (/ frac (expt 10 frac-digits))) (expt 10 exp))))))))))

(defun js-number-of (value)
  "Number(VALUE) for a JSON value, NIL for NaN."
  (cond ((realp value) value)
        ((eq value :true) 1) ((or (eq value :false) (eq value :null)) 0)
        ((stringp value) (js-number-text (js-trim value)))
        ((json-array-p value) (js-number-of (js-string-of value)))
        (t nil)))

(defun ref-of (n) "` (#N)` after a line that came from entry N, nothing without one." (if n (format nil " (#~d)" n) ""))

;;; --- what is worked out of a value once, kept with it ---------------------------

(defvar *derived* (make-hash-table :test 'eq :weakness :key)
  "What was worked out of a value read from a session file (its rendering, the
text search reads, its folded form), by the value: a live core (live.lisp)
keeps the file's values from one request to the next (JSONL-VALUES), and so
what was worked out of them. Gone with the value. Nothing worked out is
changed in place, as nothing read is.")

(defun derived (object key thunk)
  "THUNK's value for OBJECT under KEY (compared with EQUAL), worked out once."
  (let ((cell (assoc key (gethash object *derived*) :test #'equal)))
    (if cell
        (cdr cell)
        (let ((value (funcall thunk)))
          (push (cons key value) (gethash object *derived*))
          value))))
