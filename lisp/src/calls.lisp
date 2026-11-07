;;;; calls.lisp --- a stretch of messages read as calls, their results and the request.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; [Task State] and [Working Set] both read the same things off the messages
;;;; around a compaction: which calls were made, which result answers which
;;;; call, which failure is still open, and what the user last asked. They read
;;;; them here, one way, so the two sections never disagree on what failed or
;;;; what the request was.

(in-package #:keel)

(defun extension-user-p (m)
  "A user message another extension sent in the user's name (omp's `attribution: \"agent\"`), not the user's own."
  (and (json-object-p m) (equal (json-get m "role") "user") (equal (json-get m "attribution") "agent")))

(defstruct (result (:constructor make-result (pos index call text error)))
  "A tool result: the place of its message, its #N (NIL where the reader has none), the call it answers (NIL when none did), its text and whether it failed."
  pos index call text error)

(defun read-calls (messages &key (start 0) indices)
  "The calls MESSAGES make from position START, and their results.
(values CALLS RESULTS COUNT): CALLS each id's latest call, in the order the ids
were first made; RESULTS oldest first, each paired with the latest call of its
id made before it; COUNT every call made, a reused id counted each time. A
position's #N is its element in INDICES."
  (let ((by-id (make-hash-table :test 'equal)) (order '()) (results '()) (count 0)
        (indices (coerce indices 'vector)))
    (loop for m in (nthcdr start messages) for pos from start
          when (json-object-p m)
            do (when (equal (json-get m "role") "assistant")
                 (dolist (c (tool-calls-of m pos))
                   (when (call-id c)
                     (unless (nth-value 1 (gethash (call-id c) by-id)) (push (call-id c) order))
                     (setf (gethash (call-id c) by-id) c)
                     (incf count))))
               (when (equal (json-get m "role") "toolResult")
                 (push (make-result pos (and (< pos (length indices)) (let ((i (aref indices pos))) (and (realp i) i)))
                                    (gethash (json-get m "toolCallId") by-id)
                                    (text-of (json-get m "content")) (eq (json-get m "isError") :true))
                       results)))
    (values (mapcar (lambda (id) (gethash id by-id)) (nreverse order)) (nreverse results) count)))

;;; --- what a call does -------------------------------------------------------------

(defun whole-text (c)
  "What a call that writes one file whole puts in it, or NIL."
  (when (and (eq (call-kind c) :write) (= (length (files-of c)) 1) (path-key-of (call-args c)))
    (let ((content (json-get (call-args c) "content")))
      (and (stringp content) (plusp (length content)) content))))

(defun writes-whole-p (c) (and (whole-text c) t))
(defun edits-p (c) (and (not (writes-whole-p c)) (member (call-kind c) '(:edit :write)) t))
(defun changes-p (c) (or (writes-whole-p c) (edits-p c)))
(defun reads-one-p (c) (and (eq (call-kind c) :read) (= (length (files-of c)) 1)))
(defun on-file-p (c) (or (reads-one-p c) (changes-p c)))

(defparameter +line-selector+ "L?\\d+(?:(?:-|\\.\\.|\\+)L?\\d*)?|-\\d+(?:[-+]\\d+)?"
  "omp's read selector for lines: `50-100`, `L50-L60`, `50+10`, `50..60`, `-20` (the last 20).")


(defun lines-selector-p (chunk)
  (rx-test (rx (format nil "^(?:~a)$" +line-selector+) "i") chunk))

(defun reads-part-p (c)
  "A read of part of a file, by omp's line selector (`path:L10-20`) or Pi's offset and limit."
  (let ((args (call-args c)))
    (and (eq (call-kind c) :read)
         (or (nth-value 1 (gethash "offset" args)) (nth-value 1 (gethash "limit" args))
             (let* ((path (first (named-paths args)))
                    (m (and path (rx-exec (read-selector-regex) path)))
                    (selector (if (and m (plusp (rx-match-start m))) (rx-group m) "")))
               (some #'lines-selector-p (rx-split (rx "[,:]") (if (plusp (length selector)) (subseq selector 1) ""))))))))

(defun run-of (c)
  "What makes two calls the same run, so the later one's success fixes the earlier one's failure:
the tool (any read of a file is one run) and the file, else the subject (a shell's command)."
  (format nil "~a~c~a" (if (reads-one-p c) "read" (call-name c)) (code-char 0)
          (or (first (files-of c)) (second (call-subject c)) "")))

(defun title-of (c)
  "A call as a section names it: `name \"subject\"`, the subject clipped at 80; \"tool result\" for a result no call answers."
  (if (null c)
      "tool result"
      (let ((arg (second (call-subject c))))
        (if (and arg (plusp (length arg)))
            (format nil "~a ~a" (call-name c) (json-string (if (> (js-length arg) 80) (concatenate 'string (js-slice arg 0 80) "…") arg)))
            (call-name c)))))

;;; --- what is still open, and what was asked --------------------------------------

(defun open-failures (results)
  "The failed RESULTS no later success of the same run fixed, newest first.
A failure whose call is unknown has no run, so nothing fixes it."
  (let ((fixed (make-hash-table :test 'equal)) (open '()))
    (dolist (r (reverse results) (nreverse open))
      (let ((key (and (result-call r) (run-of (result-call r)))))
        (cond ((not (result-error r)) (when key (setf (gethash key fixed) t)))
              ((not (and key (gethash key fixed))) (push r open)))))))

(defun latest-request (messages)
  "The user's latest request in MESSAGES: (values POS TEXT), TEXT the message's text
without the host's injected blocks; NIL when there is none. A user message that holds
no words of the user's own (only injected text or a skill's expansion) is no request,
nor is one another extension sent in the user's name."
  (loop for m in (reverse messages) for pos downfrom (1- (length messages))
        when (and (json-object-p m) (equal (json-get m "role") "user") (not (extension-user-p m)))
          do (let ((text (rx-replace (host-block-regex) (text-of (json-get m "content")) "" :all t)))
               (when (plusp (length (user-words text))) (return (values pos text))))))
