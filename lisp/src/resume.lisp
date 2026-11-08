;;;; resume.lisp --- where the last session stopped, told to the next one.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A new session in a project starts knowing nothing of the last one, so the
;;;; agent spends its first requests finding out what was being done and which
;;;; failures were already solved. Hy-Memory 2.0 (Tencent Hunyuan) keeps a
;;;; working memory of the task and a coding memory of "experience with
;;;; conditions", both written by a model. Here both are read back from the last
;;;; session's own transcript, with no model: its [Task State] as a compaction
;;;; would build it (task-state.lisp), and the failures it fixed, each with the
;;;; condition that fixed it (the same run passing later, the files changed in
;;;; between). Sent once, with the user's first prompt; nothing for a session
;;;; that has a message already (resumed, forked).

(in-package #:keel)

(defparameter +resume-fixes+ 3 "The fixed failures a briefing tells, the newest.")
(defparameter +resume-files+ 4 "The changed files a fix names.")

(defun session-since-clear (path)
  "PATH's messages on its active branch since its last /clear: (values MESSAGES INDICES)."
  (let* ((entries (jsonl-values path))
         (branch (let ((ids (active-branch-ids entries)))
                   (coerce (remove-if-not (lambda (e) (and (hash-table-p e) (gethash (json-get e "id") ids))) entries) 'vector)))
         (after (let ((ids (make-hash-table :test 'equal)))
                  (loop for i from (1+ (last-reset-index branch)) below (length branch)
                        do (setf (gethash (json-get (aref branch i) "id") ids) t))
                  ids))
         (kept (remove-if-not (lambda (m) (and (second m) (gethash (second m) after) (json-object-p (third m))))
                              (indexed-messages entries))))
    (values (mapcar #'third kept) (mapcar #'first kept))))

(defun fixed-failures (messages indices)
  "The failures MESSAGES fixed, oldest first, each (CALL FAIL-N PASS-N FILES): a
failed result whose run (calls.lisp run-of) passed later, and the files changed
in between. No output text: what a tool printed stays with its session, where
the #N reads it (an injection carried into the next session is how one persists)."
  (let ((changes '()) (open '()) (fixes '()) (indices (coerce indices 'vector)))
    (multiple-value-bind (calls results) (read-calls messages :indices indices)
      (declare (ignore calls))
      ;; What each position changed, so a fix can name what changed between its failure and its pass.
      (loop for m in messages for pos from 0
            when (equal (json-get m "role") "assistant")
              do (dolist (c (tool-calls-of m pos))
                   (when (changes-p c) (dolist (p (files-of c)) (push (cons pos p) changes)))))
      (setf changes (nreverse changes))
      (dolist (r results)
        (let ((run (and (result-call r) (run-of (result-call r)))))
          (when run
            (if (result-error r)
                (push (cons run r) open)
                (let ((failed (remove run open :key #'car :test-not #'equal)))
                  (when failed
                    (let* ((first-fail (cdr (car (last failed))))
                           (files (remove-duplicates
                                   (loop for (pos . p) in changes
                                         when (< (result-pos first-fail) pos (result-pos r)) collect p)
                                   :test #'string= :from-end t)))
                      (push (list (result-call first-fail) (result-index first-fail) (result-index r) files)
                            fixes))
                    (setf open (remove run open :key #'car :test #'equal)))))))))
    (nreverse fixes)))

(defun fix-line (fix)
  (destructuring-bind (call fail-n pass-n files) fix
    (let ((shown (subseq files 0 (min +resume-files+ (length files)))))
      (format nil "Fixed: ~a failed~a; passed~a~a."
              (title-of call) (ref-of fail-n) (ref-of pass-n)
              (if shown
                  (format nil " after ~a changed~a" (join-strings shown ", ")
                          (if (> (length files) (length shown)) (format nil " (+~d more)" (- (length files) (length shown))) ""))
                  "")))))

(defun resume-briefing (entries files)
  "What the agent is told of the project's last session (FILES, newest first) as
this one starts, or NIL: nothing for a session with a message already, or when
the last one made no request since its /clear."
  (unless (or (null files) (some #'counted-entry-p entries))
    (let* ((previous (first files))
           (id (let ((i (json-get (read-header previous) "id"))) (and (stringp i) i))))
      (multiple-value-bind (messages indices) (session-since-clear previous)
        (let ((state (build-task-state messages indices)))
          (when state
            (let* ((fixes (fixed-failures messages indices))
                   (fixes (last fixes +resume-fixes+)))
              (format nil "Where the last session~@[ (~a)~] stopped, read from its transcript:~%~{~a~%~}~{~a~%~}~a"
                      (and id (subseq id 0 (min 8 (length id))))
                      state (mapcar #'fix-line fixes)
                      (if id
                          (format nil "~a with session:~a reads any #N of it." +recall-tool+ (json-string (subseq id 0 (min 8 (length id)))))
                          (format nil "~a mode:'sessions' finds it." +recall-tool+))))))))))
