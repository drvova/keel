;;;; support.lisp --- the test runner.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; No test framework: DEFTEST registers a test, IS records a failure, and
;;;; RUN-ALL runs every test and answers whether all passed. The parity of the
;;;; core with the TS code it replaces is checked from the TS side
;;;; (tests/lisp-core.test.ts); these tests hold what only the Lisp side sees.

(defpackage #:omp-vcc.test
  (:use #:cl #:omp-vcc)
  (:export #:run-all))

(in-package #:omp-vcc.test)

(defvar *tests* '() "Registered tests, newest first.")
(defvar *failures* '() "Failures of the test running now.")

(defmacro deftest (name &body body)
  `(progn (defun ,name () ,@body)
          (pushnew ',name *tests*)
          ',name))

(defmacro is (form &optional description)
  `(unless ,form
     (push ,(or description (format nil "~s was false" form)) *failures*)))

(defun run-all ()
  "Run every test; print each failure; true when none failed."
  (let ((failed 0) (count 0))
    (dolist (name (reverse *tests*))
      (incf count)
      (let ((*failures* '()))
        (handler-case (funcall name)
          (error (e) (push (format nil "signalled ~a" e) *failures*)))
        (when *failures*
          (incf failed)
          (format t "~&FAIL ~(~a~)~%~{  ~a~%~}" name (reverse *failures*)))))
    (format t "~&~d tests, ~d failed~%" count failed)
    (zerop failed)))
