;;;; extract.lisp --- the summary's sections, one extractor each.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; What the user wrote and the session's first requests, files read, modified
;;;; and created, git commits and their hashes, and the invocations of the
;;;; commands settings name. tests/extract-*.test.ts hold them to what they read.

(in-package #:keel)

;;; --- words -------------------------------------------------------------------
;;;
;;; Words are SBCL's UAX #29 segments. They are Intl.Segmenter's in scripts
;;; written with spaces; in those ICU segments by dictionary (Chinese,
;;; Japanese, Thai, Lao, Khmer, Myanmar), UAX #29 makes each ideograph a word
;;; and a run of Thai one, where ICU finds the dictionary's words.

;;; --- [User Messages] and [Early Session Requests] ---------------------------------

(defparameter +user-message-chars+ 300 "Each user message is clipped to this many characters.")
(defparameter +early-requests-kept+ 3 "[Early Session Requests] keeps this many of the first messages.")

(defun user-line (text index)
  "A user message as the summary lists it, behind a `[skill: name]` tag when it
expanded one, clipped. A cut request reads as complete without a mark, and the
cut part can be the constraint that matters, so a clipped one ends `… (#N)`."
  (multiple-value-bind (rest skills) (user-words text)
    (when (plusp (length rest))
      (let* ((line (if skills (format nil "[skill: ~a] ~a" (join-strings skills ", ") rest) rest))
             (clipped (js-clip line +user-message-chars+)))
        (if (= (js-length clipped) (js-length line))
            line
            (format nil "~a…~@[ (#~d)~]" (js-trim-end clipped) index))))))

(defun extract-user-messages (blocks)
  "What the user wrote, oldest first, clipped; injected text left out."
  (loop for b in blocks
        when (and (eq (block-kind b) :user) (not (block-injected b)))
          append (let ((line (user-line (block-text b) (block-index b)))) (and line (list line)))))

;;; --- [Files And Changes] ------------------------------------------------------------

(defstruct (oset (:constructor make-oset ())) (items (make-array 0 :adjustable t :fill-pointer t)) (seen (make-hash-table :test 'equal)))
(defun oset-add (set x) (unless (gethash x (oset-seen set)) (setf (gethash x (oset-seen set)) t) (vector-push-extend x (oset-items set))))
(defun oset-has (set x) (gethash x (oset-seen set)))
(defun oset-list (set) (coerce (oset-items set) 'list))

(defun extract-files (blocks file-ops)
  "Files read, modified and created, in order, as (values READ MODIFIED CREATED).
A write to a path not seen before creates it, one after rewrites it; a file
created here stays created when edited after. A failed read, write or edit did
nothing. The host's FILE-OPS fill in only paths the blocks do not show: they
come from the same calls with no result read, and say a write without its kind."
  (let ((read (make-oset)) (modified (make-oset)) (created (make-oset))
        (seen (make-hash-table :test 'equal)) (shown (make-hash-table :test 'equal)))
    (flet ((change (p) (unless (oset-has created p) (oset-add modified p))))
      (dolist (b blocks)
        (when (eq (block-kind b) :tool-call)
          (let ((kind (call-kind (block-call b))))
            (dolist (p (files-of (block-call b)))
              (setf (gethash p shown) t)
              (case kind
                (:read (unless (block-failed b) (oset-add read p) (setf (gethash p seen) t)))
                (:write (unless (block-failed b) (if (gethash p seen) (change p) (oset-add created p)))
                 (setf (gethash p seen) t))
                (:edit (unless (block-failed b) (change p)) (setf (gethash p seen) t)))))))
      (dolist (p (coerce (json-get file-ops "read" #()) 'list))
        (when (and (stringp p) (not (url-path-p p)) (not (gethash p shown))) (oset-add read p)))
      (dolist (p (coerce (json-get file-ops "changed" #()) 'list))
        (when (and (stringp p) (not (url-path-p p)) (not (gethash p shown))) (change p))))
    (values (oset-list read) (oset-list modified) (oset-list created))))

;;; --- [Commits] ------------------------------------------------------------------------

(defstruct (commit (:constructor make-commit (message &optional hash))) message hash)

(defun add-commit (commits c)
  "COMMITS (a list, oldest first) with C added: one entry per commit, first seen
first; the same message hashless and hashed is one commit, kept hashed."
  (let ((dup (find-if (lambda (o) (and (string= (commit-message o) (commit-message c))
                                       (or (null (commit-hash o)) (null (commit-hash c))
                                           (string= (commit-hash o) (commit-hash c)))))
                      commits)))
    (cond ((null dup) (append commits (list (copy-commit c))))
          (t (when (and (commit-hash c) (null (commit-hash dup))) (setf (commit-hash dup) (commit-hash c)))
             commits))))

(defun clean-message (msg)
  (js-trim (rx-replace (rx "\\\\'") (rx-replace (rx "\\\\\"") msg "\"" :all t) "'" :all t)))

(defun lines-of (text) (rx-split (rx "\\\\n|\\n") text))

(defun first-line-of (text) (js-trim (or (first (lines-of text)) "")))

(defun first-heredoc-body-line (rest delim)
  (dolist (line (lines-of rest) "")
    (let ((trimmed (js-trim (rx-replace (rx "^\\t+") line ""))))
      (when (string= trimmed delim) (return ""))
      (when (plusp (length trimmed)) (return trimmed)))))

(defun delim-of (m) (or (rx-group m 1) (rx-group m 2) (rx-group m 3) ""))

(defun subject-from-heredoc-cmd (cmd)
  (let ((m (rx-exec (rx "^git\\s+commit[^\\n\"'&;|]*?\\s-[A-Za-z]*m\\s+\"\\$\\(cat\\s+<<-?\\s*(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z_]\\w*))(?:\\r?\\n|\\\\n)") cmd)))
    (and m (clean-message (first-heredoc-body-line (js-slice cmd (rx-match-end m)) (delim-of m))))))

(defun subject-from-stdin-heredoc (cmd)
  (let ((m (rx-exec (rx "git\\s+commit[^\\n]*?(?:\\s-[A-Za-z]*F|\\s--file)(?:\\s+|=)-(?=\\s)[^\\n]*?<<-?\\s*(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z_]\\w*))[^\\n]*(?:\\r?\\n|\\\\n)") cmd)))
    (and m (clean-message (first-heredoc-body-line (js-slice cmd (rx-match-end m)) (delim-of m))))))

(defun commit-segments (cmd)
  "Each `git commit` of CMD that starts a command, to the next one."
  (let ((starts '()))
    (dolist (m (rx-all (rx "\\bgit\\s+commit\\b") cmd))
      (when (or (null starts) (rx-test (rx "(?:^|[;&|(\\n])\\s*$") (js-slice cmd 0 (rx-match-start m))))
        (setf starts (append starts (list (rx-match-start m))))))
    (loop for (at next) on starts collect (js-slice cmd at next))))

(defun subject-of (seg)
  (let ((m (rx-exec (rx "git\\s+commit[^\\n]*?\\s-[A-Za-z]*m\\s+(?:\"((?:[^\"\\\\]|\\\\.)*)\"|'((?:[^'\\\\]|\\\\.)*)'|\\$?'((?:[^'\\\\]|\\\\.)*)')") seg)))
    (if (null m)
        (or (subject-from-stdin-heredoc seg) "")
        (let* ((heredoc (and (rx-group m 1) (rx-test (rx "^\\$\\(cat\\s+<<") (rx-group m 1))
                             (subject-from-heredoc-cmd (js-slice seg (rx-match-start m)))))
               (message (or heredoc (first-line-of (clean-message (or (rx-group m 1) (rx-group m 2) (rx-group m 3) ""))))))
          (if (and (null heredoc) (rx-test (rx "^\\$\\(cat\\s+<<") message)) "" message)))))

(defparameter +git-commit-head+ "\\[[^\\]\\s]+(?:\\s+\\([^)]*\\))?\\s+([0-9a-f]{7,12})\\]"
  "What git commit prints first: `[branch (root-commit) hash]`, the hash its one group.")

(defun hash-subject-regex ()
  (rx (format nil "(?:~a|^\\s*([0-9a-f]{7,12})(?:\\s+\\([^)]*\\))?)\\s+(.*)" +git-commit-head+)))

(defun result-lines (results) (mapcan (lambda (text) (split-string text #\Newline)) results))

(defun hash-for-subject (results message)
  (dolist (line (result-lines results))
    (let ((m (rx-exec (hash-subject-regex) line)))
      (when (and m (string= (js-trim (rx-group m 3)) message)) (return (or (rx-group m 1) (rx-group m 2)))))))

(defun committed-line (results message)
  (dolist (line (result-lines results))
    (let ((m (rx-exec (rx (format nil "~a\\s+(.*)" +git-commit-head+)) line)))
      (when (and m (string= (js-trim (rx-group m 2)) message)) (return (rx-group m 1))))))

(defun hash-from-results (results message)
  (or (dolist (text results)
        (let ((m (rx-exec (rx +git-commit-head+) text)))
          (when m (return (rx-group m 1)))))
      (hash-for-subject results message)
      (dolist (text results)
        (let ((m (rx-exec (rx "\\b([0-9a-f]{7,12})\\.\\.([0-9a-f]{7,12})\\b") text)))
          (when m (return (rx-group m 2)))))
      (dolist (line (result-lines results))
        (let ((m (rx-exec (rx "^\\s*([0-9a-f]{7,40})\\s*$") line)))
          (when (and m (rx-test (rx "[a-f]") (rx-group m 1))) (return (js-slice (rx-group m 1) 0 12)))))))

(defun amended-commit (results)
  (dolist (line (result-lines results))
    (let ((m (rx-exec (hash-subject-regex) line)))
      (when (and m (plusp (length (js-trim (rx-group m 3)))))
        (return (make-commit (js-trim (rx-group m 3)) (or (rx-group m 1) (rx-group m 2))))))))

(defun outcome-of (blocks i)
  "What the command block I printed and whether it failed, as (values RESULTS FAILED)."
  (let ((b (nth i blocks)))
    (if (eq (block-kind b) :bash)
        (values (list (block-output b)) (nonzero-exit-p (block-exit-code b)))
        (values (and (eq (block-kind b) :tool-call) (block-results b))
                (and (eq (block-kind b) :tool-call) (block-failed b))))))

(defun extract-commits (blocks)
  "Git commits the session made, each with the hash its output reported."
  (let ((commits '()))
    (loop for b in blocks
          for i from 0
          do (let ((segments (commit-segments (or (command-of b) ""))))
               (when segments
                 (multiple-value-bind (results failed) (outcome-of blocks i)
                   (dolist (seg segments)
                     (let* ((amend (rx-test (rx "\\s--amend\\b") seg))
                            (message (subject-of seg)))
                       (unless (and failed (not (if (plusp (length message))
                                                    (committed-line results message)
                                                    (and amend (amended-commit results)))))
                         (if amend
                             (let* ((reported (if (plusp (length message)) nil (amended-commit results)))
                                    (subject (if (plusp (length message)) message (and reported (commit-message reported))))
                                    (hash (if (plusp (length message))
                                              (if (= (length segments) 1) (hash-from-results results message) (hash-for-subject results message))
                                              (and reported (commit-hash reported))))
                                    (target (find-if (lambda (c) (if (and (zerop (length message)) subject)
                                                                     (string= (commit-message c) subject)
                                                                     t))
                                                     commits :from-end t)))
                               (cond ((and target subject) (setf (commit-message target) subject (commit-hash target) hash))
                                     (target (setf (commit-hash target) nil))
                                     (subject (setf commits (append commits (list (make-commit subject hash)))))))
                             (when (plusp (length message))
                               (setf commits (add-commit commits
                                                         (make-commit message (if (= (length segments) 1)
                                                                                  (hash-from-results results message)
                                                                                  (hash-for-subject results message))))))))))))))
    commits))

;;; --- [Tracked Commands] ----------------------------------------------------------------
;;;
;;; Commands are scanned by UTF-16 code unit, as JavaScript indexes strings.

(defun units-slice (units start &optional end)
  "The string of UNITS from START below END, a pair cut in half left as its surrogate."
  (let ((end (min (or end (length units)) (length units))))
    (with-output-to-string (out)
      (loop with i = start
            while (< i end)
            do (let ((u (aref units i)))
                 (if (and (<= #xD800 u #xDBFF) (< (1+ i) end) (<= #xDC00 (aref units (1+ i)) #xDFFF))
                     (progn (write-char (code-char (+ #x10000 (ash (- u #xD800) 10) (- (aref units (1+ i)) #xDC00))) out) (incf i 2))
                     (progn (write-char (code-char u) out) (incf i))))))))

(defun unit-is (units i char) (and (<= 0 i) (< i (length units)) (= (aref units i) (char-code char))))
(defun unit-space-p (units i) (and (<= 0 i) (< i (length units)) (js-whitespace-p (code-char (aref units i)))))

(defun unquoted-separators (units)
  "The unit index of every unquoted shell separator (; & | newline)."
  (let ((seps '()) (quote nil) (i 0) (n (length units)))
    (loop while (< i n)
          do (let ((c (code-char (aref units i))))
               (cond (quote (cond ((and (char= c #\\) (char= quote #\")) (incf i))
                                  ((char= c quote) (setf quote nil))))
                     ((char= c #\\) (incf i))
                     ((member c '(#\' #\")) (setf quote c))
                     ((and (char= c #\#) (or (zerop i) (unit-space-p units (1- i))
                                             (member (code-char (aref units (1- i))) '(#\; #\& #\| #\())))
                      (loop while (and (< (1+ i) n) (not (unit-is units (1+ i) #\Newline))) do (incf i)))
                     ((and (char= c #\&) (or (unit-is units (1- i) #\>) (unit-is units (1- i) #\<) (unit-is units (1+ i) #\>))))
                     ((member c '(#\; #\& #\| #\Newline)) (push i seps))))
             (incf i))
    (nreverse seps)))

(defun capture-entry (text)
  "TEXT up to its first unquoted separator, trimmed."
  (let* ((units (string-units text)) (seps (unquoted-separators units)))
    (js-trim (if seps (units-slice units 0 (first seps)) text))))

(defun token-at (units pos)
  "The next token on the line from POS, as (values TOKEN-UNITS-LENGTH START)."
  (loop while (and (< pos (length units)) (member (aref units pos) '(32 9))) do (incf pos))
  (let ((end pos))
    (loop while (and (< end (length units)) (not (unit-space-p units end))) do (incf end))
    (values (- end pos) pos)))

(defparameter +wrappers+ '("sudo" "env" "nohup" "time" "command"))

(defun skip-to-command (units pos)
  "Where the real command begins at POS, past VAR=val prefixes and wrapper commands."
  (loop
    (multiple-value-bind (len at) (token-at units pos)
      (when (zerop len) (return at))
      (let ((tok (units-slice units at (+ at len))))
        (cond ((rx-test (rx "^[A-Za-z_]\\w*=") tok) (setf pos (+ at len)))
              ((not (member tok +wrappers+ :test #'string=)) (return at))
              (t (setf pos (+ at len))
                 (loop (multiple-value-bind (flen fat) (token-at units pos)
                         (let ((flag (units-slice units fat (+ fat flen))))
                           (unless (starts-with "-" flag) (return))
                           (setf pos (+ fat flen))
                           (when (or (and (string= tok "sudo") (rx-test (rx "^-[ugpCDRT]$") flag))
                                     (and (string= tok "env") (rx-test (rx "^-[uS]$") flag)))
                             (multiple-value-bind (vlen vat) (token-at units pos)
                               (setf pos (+ vat vlen)))))))))))))

(defun top-level-invocations (units name)
  "The segment starts where NAME is invoked: after an unquoted separator, its own word."
  (let ((name-units (string-units name)) (starts '()))
    (dolist (bound (cons 0 (mapcar #'1+ (unquoted-separators units))) (nreverse starts))
      (let ((pos (skip-to-command units bound)))
        (when (and (<= (+ pos (length name-units)) (length units))
                   (loop for k below (length name-units) always (= (aref units (+ pos k)) (aref name-units k)))
                   (let ((after (+ pos (length name-units))))
                     (or (>= after (length units)) (unit-space-p units after))))
          (push bound starts))))))

(defun ssh-remote-command (after-ssh)
  "What ssh runs remotely: the arguments after its target, or NIL."
  (let* ((tokens (rx-all (rx "\\S+") after-ssh)) (i 0))
    (loop while (and (< i (length tokens)) (starts-with "-" (rx-group (nth i tokens))))
          do (incf i (if (rx-test (rx "^-[46ACfGgKkMNTtVvXxYynaq]+$") (rx-group (nth i tokens))) 1 2)))
    (let ((target (nth i tokens)))
      (when target
        (let ((rest (js-trim (js-slice after-ssh (rx-match-end target)))))
          (and (plusp (length rest)) rest))))))

(defun extract-tracked-commands (blocks names)
  "Per tracked command name, its invocations oldest first (one re-run moves to
the end), as an alist (NAME . ENTRIES) in the order NAMES gives them."
  (let ((by (mapcar (lambda (n) (cons n '())) (remove-duplicates names :test #'string= :from-end t))))
    (flet ((record (name item)
             (let ((cell (assoc name by :test #'string=)))
               (setf (cdr cell) (append (remove item (cdr cell) :test #'string=) (list item))))))
      (when names
        (dolist (b blocks)
          (let ((cmd (command-of b)))
            (when (and cmd (plusp (length cmd)))
              (let ((units (string-units cmd)))
                (dolist (name names)
                  (dolist (start (top-level-invocations units name))
                    (let ((item (capture-entry (js-trim (units-slice units start)))))
                      (when (plusp (length item)) (record name item)))))
                (when (member "ssh" names :test #'string=)
                  (dolist (bound (top-level-invocations units "ssh"))
                    (let* ((seg (string-units (units-slice units bound)))
                           (remote (ssh-remote-command (units-slice seg (+ (skip-to-command seg 0) 3)))))
                      (when remote
                        (let* ((unquoted (rx-replace (rx "['\"]") remote "" :all t))
                               (uu (string-units unquoted)))
                          (dolist (name names)
                            (unless (string= name "ssh")
                              (dolist (start (top-level-invocations uu name))
                                (let ((item (capture-entry (js-trim (units-slice uu start)))))
                                  (when (plusp (length item)) (record name item)))))))))))))))))
    by))
