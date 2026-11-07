;;;; task-state.lisp --- [Task State]: where the work stands when a compaction lands.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The latest request, the tool calls after it (how many, how many failed,
;;;; what they changed), the last result and the failure no later run of the
;;;; same call fixed, from the originals of everything since /clear
;;;; (calls.lisp reads them). It is there at every compaction, in the same
;;;; shape, so an agent always finds where it stood in the same place; it is
;;;; built again each time and never carried, since a carried state would be a
;;;; previous compaction's guess at what is still true.

(in-package #:omp-vcc)

(defparameter +changed-shown+ 8)
(defparameter +error-line-chars+ 200)

(defun ref-of (n) (if n (format nil " (#~d)" n) ""))

(defun last-said-line (text)
  "The last line of TEXT that says something, clipped: errors come last."
  (let ((lines (remove "" (mapcar #'js-trim (split-string text #\Newline)) :test #'string=)))
    (js-clip (or (car (last lines)) "") +error-line-chars+)))

(defun build-task-state (messages indices)
  "The section's lines, NIL when there is no request since /clear."
  (multiple-value-bind (at request-text) (latest-request messages)
    (unless at (return-from build-task-state nil))
    (flet ((index (pos) (let ((i (nth pos indices))) (and (realp i) i))))
      (let ((lines (list (format nil "Request~a: ~a" (ref-of (index at)) (user-line request-text (index at))))))
        (multiple-value-bind (calls results call-count) (read-calls messages :start (1+ at) :indices indices)
          (when (zerop call-count)
            (return-from build-task-state (append lines (list "Since then: no tool calls yet."))))
          (let* ((changed (let ((paths '()))
                            ;; Newest call id first (a reused id stays where it was first made, holding its latest call).
                            (dolist (c calls (nreverse paths))
                              (when (changes-p c)
                                (dolist (p (files-of c)) (unless (member p paths :test #'string=) (push p paths)))))))
                 (failed (count-if #'result-error results))
                 (shown (subseq changed 0 (min +changed-shown+ (length changed))))
                 (more (- (length changed) (length shown)))
                 (open (first (open-failures results)))
                 (last (car (last results))))
            (setf lines (append lines (list (format nil "Since then: ~d tool call~:p~a~a."
                                                    call-count
                                                    (if (plusp failed) (format nil ", ~d failed" failed) "")
                                                    (if changed
                                                        (format nil "; changed ~a~a" (join-strings shown ", ") (if (plusp more) (format nil " (+~d more)" more) ""))
                                                        "; no file changed")))))
            (when (and last (not (eq last open)))
              (setf lines (append lines (list (format nil "Last result~a: ~a ~a." (ref-of (result-index last)) (title-of (result-call last))
                                                      (if (result-error last) "failed" "succeeded"))))))
            (when open
              (let ((error-line (last-said-line (result-text open))))
                (setf lines (append lines (list (format nil "Unresolved failure~a: ~a~a" (ref-of (result-index open)) (title-of (result-call open))
                                                        (if (plusp (length error-line)) (format nil ": ~a" error-line) "")))))))
            lines))))))
