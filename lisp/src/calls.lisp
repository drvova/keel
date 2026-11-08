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

(defun url-path-p (path) (rx-test (rx "^[a-z][a-z0-9+.-]*:\\/\\/" "i") path))

(defun read-selector-regex ()
  "A read path's selector: `:raw`, `:img`, `:conflicts` or lines, several joined by `,` or `:`."
  (rx (format nil ":(?:raw|img|conflicts|~a)(?:[,:](?:raw|img|conflicts|~a))*$" +line-selector+ +line-selector+) "i"))

(defun strip-read-selector (path)
  "A read's path without omp's selector (`:50-100`, `:raw`)."
  (let ((m (rx-exec (read-selector-regex) path)))
    (if (and m (plusp (rx-match-start m))) (js-slice path 0 (rx-match-start m)) path)))

(defun files-of (call)
  "The files a call works on: its named paths less URLs, a read's selector dropped; none for a search or a shell."
  (when (eq (call-files call) :unset)
    (setf (call-files call)
          (let ((kind (call-kind call)))
            (if (member kind '(:search :shell))
                '()
                (let ((paths (remove-if #'url-path-p (named-paths (call-args call)))))
                  (if (eq kind :read) (mapcar #'strip-read-selector paths) paths))))))
  (call-files call))

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

;;; --- what a later entry superseded, what is still open, and what was asked ---------------

(defun file-changes (messages &key indices)
  "Every change of a file MESSAGES make, oldest first, as (PATH POS N): N the #N of
the message making it (its element in INDICES)."
  (let ((indices (coerce indices 'vector)))
    (loop for m in messages for pos from 0
          when (and (json-object-p m) (equal (json-get m "role") "assistant"))
            nconc (loop for c in (tool-calls-of m pos)
                        when (changes-p c)
                          nconc (loop for p in (files-of c)
                                      collect (list p pos (and (< pos (length indices)) (aref indices pos))))))))

(defun stale-read (r changes)
  "When the file R's call read or edited was changed after R (CHANGES, FILE-CHANGES):
(values PATH N), the first such change; what R shows of it no longer holds."
  (let ((c (result-call r)))
    (when (and c (on-file-p c))
      (loop for p in (files-of c)
            for later = (find-if (lambda (ch) (and (> (second ch) (result-pos r)) (string= (first ch) p))) changes)
            when later return (values p (third later))))))

(defun fixes-of (results)
  "Each failed result of RESULTS, to the first later success of the same run (calls
are the same run by RUN-OF), in an EQ hash. A failure whose call is unknown has no
run, so nothing fixes it."
  (let ((fixes (make-hash-table :test 'eq)) (waiting (make-hash-table :test 'equal)))
    (dolist (r results fixes)
      (let ((key (and (result-call r) (run-of (result-call r)))))
        (when key
          (if (result-error r)
              (push r (gethash key waiting))
              (progn (dolist (f (gethash key waiting)) (setf (gethash f fixes) r))
                     (remhash key waiting))))))))

(defun open-failures (results)
  "The failed RESULTS no later success of the same run fixed, newest first."
  (let ((fixes (fixes-of results)))
    (reverse (remove-if-not (lambda (r) (and (result-error r) (not (gethash r fixes)))) results))))

(defun call-index (r indices)
  "The #N of the message holding R's call, or NIL."
  (let ((c (result-call r))) (and c (let ((n (nth (call-pos c) indices))) (and (realp n) n)))))

(defun request-text (m)
  "M's text without the host's injected blocks, when M is a request the user made;
NIL otherwise: another role, a message another extension sent in the user's name,
or one that holds no words of the user's own (only injected text or a skill's expansion)."
  (when (and (json-object-p m) (equal (json-get m "role") "user") (not (extension-user-p m)))
    (let ((text (rx-replace (host-block-regex) (text-of (json-get m "content")) "" :all t)))
      (and (plusp (length (user-words text))) text))))

(defun request-words (m)
  "The user's own words of request M on one line, \"\" when M is no request."
  (let ((text (request-text m))) (if text (values (user-words text)) "")))

(defun latest-request (messages)
  "The user's latest request in MESSAGES: (values POS TEXT), TEXT as REQUEST-TEXT reads it; NIL when there is none."
  (loop for m in (reverse messages) for pos downfrom (1- (length messages))
        for text = (request-text m)
        when text return (values pos text)))
