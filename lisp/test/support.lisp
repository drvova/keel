;;;; support.lisp --- the test runner.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; No test framework: DEFTEST registers a test, IS records a failure, and
;;;; RUN-ALL runs every test and answers whether all passed. The TypeScript
;;;; suite drives the core through its ops; these tests hold its parts.

(defpackage #:omp-vcc.test
  (:use #:cl #:omp-vcc)
  ;; Internals a test holds to their numbers.
  (:import-from #:omp-vcc #:recall-output-chars #:tokens-from-chars #:calibrate-chars-per-token
                #:content-chars #:message-chars #:make-call #:reads-part-p #:strip-read-selector
                #:js-canonical #:open-failures #:read-calls #:result-text #:result-index
                #:js-number-of #:was-rewritten-p #:with-original-content #:index-by-id #:counted-entry-p)
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
