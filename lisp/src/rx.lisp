;;;; rx.lisp --- JavaScript's string methods over regex.lisp's engine.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The summary pipeline's own regular expressions (commit messages, heredocs,
;;;; shell commands, the legacy reader) are JavaScript regexes: the pattern
;;;; text in RX, run on the same engine recall's search uses, with
;;;; exec, test, replace, matchAll and split behaving as JavaScript's do.
;;;; Positions are code units, as there; JS-SLICE cuts a string at them.

(in-package #:omp-vcc)

(defmacro rx (pattern &optional (flags ""))
  "PATTERN compiled once, with FLAGS from \"i\" and \"m\" (a \"g\" says which
string methods to call, not how to match)."
  `(load-time-value (compile-regex ,pattern :ignore-case ,(and (find #\i flags) t)
                                            :multiline ,(and (find #\m flags) t))
                    t))

(defstruct (rx-match (:constructor make-rx-match (string start end captures)))
  string start end captures)

(defun rx-group (match &optional (n 0))
  "Group N of MATCH as a string (0 the whole match), or NIL when it did not take part."
  (if (zerop n)
      (js-slice (rx-match-string match) (rx-match-start match) (rx-match-end match))
      (let ((s (aref (rx-match-captures match) (* 2 n))) (e (aref (rx-match-captures match) (1+ (* 2 n)))))
        (and s e (js-slice (rx-match-string match) s e)))))

(defun rx-exec-units (regex string units &optional (start 0))
  (let ((reuse (make-array (* 2 (1+ (regex-groups regex))) :initial-element nil)))
    (loop for s from start to (length units)
          do (multiple-value-bind (end captures) (regex-match-at regex units s reuse)
               (when end (return (make-rx-match string s end (copy-seq captures))))))))

(defun rx-exec (regex string &optional (start 0))
  "REGEX's first match in STRING at or after code unit START, or NIL: RegExp.exec."
  (rx-exec-units regex string (string-units string) start))

(defun rx-test (regex string) (and (rx-exec regex string) t))

(defun rx-all (regex string)
  "Every match, as String.matchAll finds them: an empty match moves on one unit."
  (let ((units (string-units string)) (out '()) (i 0))
    (loop (let ((m (and (<= i (length units)) (rx-exec-units regex string units i))))
            (unless m (return (nreverse out)))
            (push m out)
            (setf i (if (= (rx-match-end m) (rx-match-start m)) (1+ (rx-match-end m)) (rx-match-end m)))))))

(defun rx-replace (regex string replacement &key all)
  "STRING with REGEX's first match (every match with ALL) replaced: by the
string REPLACEMENT as written, or by what the function REPLACEMENT returns for
the match. String.replace and replaceAll; no $ patterns are read."
  (let ((matches (if all (rx-all regex string) (let ((m (rx-exec regex string))) (and m (list m))))))
    (if (null matches)
        string
        (with-output-to-string (out)
          (let ((at 0))
            (dolist (m matches)
              (write-string (js-slice string at (rx-match-start m)) out)
              (write-string (if (functionp replacement) (funcall replacement m) replacement) out)
              (setf at (rx-match-end m)))
            (write-string (js-slice string at) out))))))

(defun rx-split (regex string)
  "STRING split at REGEX's matches, as String.split with a regex (no captures) does."
  (let* ((units (string-units string)) (size (length units)))
    (if (zerop size)
        (if (regex-match-at regex units 0) '() (list string))
        (let ((parts '()) (p 0) (q 0))
          (loop while (< q size)
                do (let ((e (regex-match-at regex units q)))
                     (if (or (null e) (= e p))
                         (incf q)
                         (progn (push (js-slice string p q) parts)
                                (setf p e q p)))))
          (push (js-slice string p) parts)
          (nreverse parts)))))

(defun js-trim-end (string)
  (let ((end (position-if-not #'js-whitespace-p string :from-end t)))
    (if end (subseq string 0 (1+ end)) "")))

(defun js-trim-start (string)
  (let ((start (position-if-not #'js-whitespace-p string)))
    (if start (subseq string start) "")))

(defun starts-with (prefix string &key (start 0))
  (and (<= (+ start (length prefix)) (length string))
       (string= prefix string :start2 start :end2 (+ start (length prefix)))))

(defun ends-with (suffix string)
  (and (<= (length suffix) (length string))
       (string= suffix string :start2 (- (length string) (length suffix)))))

(defun js-index-of (needle string &optional (start 0))
  "The code unit where NEEDLE first occurs in STRING at or after unit START, or -1."
  (let* ((units (string-units string)) (n (string-units needle)) (m (length n)))
    (loop for p from start to (- (length units) m)
          when (loop for k below m always (= (aref units (+ p k)) (aref n k)))
            return p
          finally (return -1))))

(defun js-last-index-of (needle string limit)
  "The code unit where NEEDLE last occurs in STRING at or before unit LIMIT, or -1."
  (let* ((units (string-units string)) (n (string-units needle)) (m (length n)))
    (loop for p from (min limit (- (length units) m)) downto 0
          when (loop for k below m always (= (aref units (+ p k)) (aref n k)))
            return p
          finally (return -1))))

(defun js-round (x)
  "Math.round of the double X: the nearest integer, halves up."
  (let* ((x (coerce x 'double-float)) (f (ffloor x)))
    (truncate (if (>= (- x f) 0.5d0) (+ f 1) f))))

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
