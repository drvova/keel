;;;; task-state.lisp --- [Task State]: where the work stands when a compaction lands.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/task-state.ts: the latest request, the tool calls after
;;;; it (how many, how many failed, what they changed), the last result and the
;;;; failure no later run of the same call fixed, from the originals of
;;;; everything since /clear. Shown only when the request is summarized away;
;;;; built again at every compaction, never carried. Why, the TS says.

(in-package #:omp-vcc)

(defparameter +changed-shown+ 8)
(defparameter +error-line-chars+ 200)

(defun ref-of (n) (if n (format nil " (#~d)" n) ""))

(defun last-said-line (text)
  "The last line of TEXT that says something, clipped: errors come last."
  (let ((lines (remove "" (mapcar #'js-trim (split-string text #\Newline)) :test #'string=)))
    (js-clip (or (car (last lines)) "") +error-line-chars+)))

(defun build-task-state (messages indices kept-from)
  "task-state.ts buildTaskState: the section's lines, NIL when no request is summarized away."
  (let* ((messages (coerce messages 'vector))
         (indices (coerce indices 'vector))
         (n (length messages))
         (at -1) (request nil))
    (flet ((index (pos) (and (< pos (length indices)) (let ((i (aref indices pos))) (and (realp i) i)))))
      (loop for i from (1- n) downto 0
            for m = (aref messages i)
            when (and (json-object-p m) (equal (json-get m "role") "user") (not (extension-user-p m)))
              do (let ((line (user-line (rx-replace (host-block-regex) (text-of (json-get m "content")) "" :all t) (index i))))
                   (when line (setf at i request line) (return))))
      (when (or (< at 0) (>= at kept-from)) (return-from build-task-state nil))
      (let ((lines (list (format nil "Request~a: ~a" (ref-of (index at)) request)))
            (calls (make-hash-table :test 'equal)) (order '()) (results '()) (call-count 0))
        (loop for pos from (1+ at) below n
              for m = (aref messages pos)
              do (dolist (c (ws-calls-of m pos))
                   (unless (nth-value 1 (gethash (ws-call-id c) calls)) (push (ws-call-id c) order))
                   (setf (gethash (ws-call-id c) calls) c)
                   (incf call-count))
                 (when (and (json-object-p m) (equal (json-get m "role") "toolResult"))
                   (push (list pos (gethash (json-get m "toolCallId") calls) (text-of (json-get m "content")) (eq (json-get m "isError") :true))
                         results)))
        (setf results (nreverse results))
        (when (zerop call-count)
          (return-from build-task-state (append lines (list "Since then: no tool calls yet."))))
        (let* ((changed (let ((paths '()))
                          ;; Newest call id first (a reused id stays where it was first made, holding its latest call).
                          (dolist (id order (nreverse paths))
                            (let ((c (gethash id calls)))
                              (when (or (ws-writes-p c) (ws-edits-p c))
                                (dolist (p (ws-call-paths c)) (unless (member p paths :test #'string=) (push p paths))))))))
               (failed (count-if #'fourth results))
               (shown (subseq changed 0 (min +changed-shown+ (length changed))))
               (more (- (length changed) (length shown))))
          (setf lines (append lines (list (format nil "Since then: ~d tool call~:p~a~a."
                                                  call-count
                                                  (if (plusp failed) (format nil ", ~d failed" failed) "")
                                                  (if changed
                                                      (format nil "; changed ~a~a" (join-strings shown ", ") (if (plusp more) (format nil " (+~d more)" more) ""))
                                                      "; no file changed")))))
          (let* ((open (loop for r in (reverse results)
                             when (and (fourth r)
                                       (let ((key (and (second r) (run-of (second r)))))
                                         (notany (lambda (x) (and (> (first x) (first r)) (not (fourth x)) (second x) key
                                                                  (string= (run-of (second x)) key)))
                                                 results)))
                               return r))
                 (last (car (last results))))
            (when (and last (not (eq last open)))
              (setf lines (append lines (list (format nil "Last result~a: ~a ~a." (ref-of (index (first last))) (title-of (second last))
                                                      (if (fourth last) "failed" "succeeded"))))))
            (when open
              (let ((error-line (last-said-line (third open))))
                (setf lines (append lines (list (format nil "Unresolved failure~a: ~a~a" (ref-of (index (first open))) (title-of (second open))
                                                        (if (plusp (length error-line)) (format nil ": ~a" error-line) "")))))))
            lines))))))
