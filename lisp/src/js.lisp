;;;; js.lisp --- JavaScript's reading of JSON values, for the code that reads the hosts' JSON.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; What the hosts write is JavaScript's: a field may be absent, null, false,
;;;; 0 or "" where the code means "none", an array is a vector (and a string is
;;;; a vector too, to Lisp), and a number may be an integer written as a float.
;;;; These read them the one way, for every module.

(in-package #:omp-vcc)

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
