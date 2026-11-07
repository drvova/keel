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
;;;;
;;;; The other sections say what happened; what the agent needs first after a
;;;; compaction is where it is in the task in progress. Agents that keep that
;;;; state apart from the history recover better on long tasks (HyMem's typed
;;;; results, arXiv:2608.15703; a fixed task segment beside the history,
;;;; arXiv:2512.22087); those papers have a model write it, here it is read off
;;;; the transcript by rule, so nothing depends on wording. Each line names the
;;;; #N that holds the rest, so the agent reads where it stands in one place
;;;; instead of spending requests finding out.

(in-package #:keel)

(defparameter +changed-shown+ 8 "Changed files named in the section; past this the count says how many more.")
(defparameter +error-line-chars+ 200 "An error line is clipped to this many characters.")

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
