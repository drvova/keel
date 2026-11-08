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
         (branch (file-branch path))
         (after (let ((ids (make-hash-table :test 'equal)))
                  (loop for i from (1+ (last-reset-index branch)) below (length branch)
                        do (setf (gethash (json-get (aref branch i) "id") ids) t))
                  ids))
         (kept (remove-if-not (lambda (m) (and (second m) (gethash (second m) after) (json-object-p (third m))))
                              (indexed-messages entries))))
    (values (mapcar #'third kept) (mapcar #'first kept))))


(defun fixed-failures (messages indices)
  "The failures MESSAGES fixed, oldest first, each (CALL FAIL-N PASS-N FILES): the
first failure of a run that passed later (calls.lisp FIXES-OF), and the files
changed between it and the pass. No output text: what a tool printed stays with
its session, where the #N reads it (an injection carried into the next session
is how one persists)."
  (multiple-value-bind (calls results) (read-calls messages :indices indices)
    (declare (ignore calls))
    (let ((changes (file-changes messages :indices indices)) (by-fix (make-hash-table :test 'eq)))
      (maphash (lambda (failed fix) (push failed (gethash fix by-fix))) (fixes-of results))
      (loop for fix in results
            for failed = (gethash fix by-fix)
            when failed
              collect (let ((first (reduce (lambda (a b) (if (< (result-pos a) (result-pos b)) a b)) failed)))
                        (list (result-call first) (result-index first) (result-index fix)
                              (remove-duplicates (loop for (p pos) in changes
                                                       when (< (result-pos first) pos (result-pos fix)) collect p)
                                                 :test #'string= :from-end t)))))))

(defun fix-line (fix)
  (destructuring-bind (call fail-n pass-n files) fix
    (let ((shown (subseq files 0 (min +resume-files+ (length files)))))
      (format nil "Fixed: ~a failed~a; passed~a~a."
              (title-of call) (ref-of fail-n) (ref-of pass-n)
              (if shown
                  (format nil " after ~a changed~a" (join-strings shown ", ")
                          (if (> (length files) (length shown)) (format nil " (+~d more)" (- (length files) (length shown))) ""))
                  "")))))

(defun write-time (path)
  "PATH's last write, or NIL when there is no such file."
  (ignore-errors (let ((p (probe-file (native-path path)))) (and p (file-write-date p)))))

(defun changed-since (paths cwd ended)
  "The PATHS (relative to CWD) whose files were written after ENDED, a universal
time: what the last session said of them may no longer hold."
  (when ended
    (remove-if-not (lambda (p)
                     (let ((full (if (or (absolute-path-p p) (not (stringp cwd)) (zerop (length cwd))) p (join-path cwd p))))
                       (let ((at (write-time full))) (and at (> at ended)))))
                   paths)))

(defun resume-briefing (entries files)
  "What the agent is told of the project's last session (FILES, newest first) as
this one starts, or NIL: nothing for a session with a message already, or when
the last one made no request since its /clear."
  (unless (or (null files) (some #'counted-entry-p entries))
    (let* ((previous (first files))
           (header (read-header previous))
           (id (let ((i (json-get header "id"))) (and (stringp i) i))))
      (multiple-value-bind (messages indices) (session-since-clear previous)
        (let ((state (build-task-state messages indices)))
          (when state
            (let* ((fixes (last (fixed-failures messages indices) +resume-fixes+))
                   ;; What it changed, and what its fixes rest on, written again since it ended (MemTrace's
                   ;; applicability check, arXiv:2610.04838, by the files' own write times).
                   (worked (remove-duplicates
                            (append (loop for m in messages
                                          when (equal (json-get m "role") "assistant")
                                            nconc (loop for c in (tool-calls-of m) when (changes-p c) append (copy-list (files-of c))))
                                    (loop for f in fixes append (copy-list (fourth f))))
                            :test #'string= :from-end t))
                   (moved (changed-since worked (json-get header "cwd") (write-time previous))))
              (format nil "Where the last session~@[ (~a)~] stopped, read from its transcript:~%~{~a~%~}~{~a~%~}~@[~a~%~]~a"
                      (and id (short-id id))
                      state (mapcar #'fix-line fixes)
                      (and moved (format nil "Changed since it ended: ~a. What it says of ~:[it~;them~] may no longer hold."
                                         (join-strings (subseq moved 0 (min +resume-files+ (length moved))) ", ") (rest moved)))
                      (if id
                          (format nil "~a with session:~a reads any #N of it." +recall-tool+ (json-string (short-id id)))
                          (format nil "~a mode:'sessions' finds it." +recall-tool+))))))))))
