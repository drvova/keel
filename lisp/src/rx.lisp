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

