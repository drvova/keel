;;;; brief.lisp --- the brief transcript, and which blocks it covers.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/brief.ts (each block as a line or two: the user's words
;;;; cut by significant words, the assistant's head and tail, a tool call in one
;;;; line, a shell command compressed) and src/core/rank.ts (the blocks the
;;;; brief covers when they do not all fit: scored by what they did, the newest
;;;; kept, within a size budget).

(in-package #:omp-vcc)

;;; --- cutting text by significant words -----------------------------------------

(defparameter +truncate-user+ 256)
(defparameter +closing-head-words+ 120)
(defparameter +closing-tail-words+ 120)
(defparameter +assistant-head-words+ 80)
(defparameter +assistant-tail-words+ 120)

(defparameter +brief-stop-words+
  (let ((table (make-hash-table :test 'equal)))
    (dolist (w '("a" "an" "the" "is" "are" "was" "were" "be" "been" "being"
                 "have" "has" "had" "do" "does" "did" "will" "would" "could"
                 "should" "may" "might" "shall" "can" "need" "must"
                 "to" "of" "in" "for" "on" "with" "at" "by" "from" "as"
                 "into" "through" "during" "before" "after" "above" "below"
                 "between" "under" "over"
                 "and" "but" "or" "nor" "not" "so" "yet" "both" "either"
                 "neither" "each" "every" "all" "any" "few" "more" "most"
                 "other" "some" "such" "no"
                 "that" "this" "these" "those" "it" "its"
                 "i" "me" "my" "we" "our" "you" "your" "he" "him" "his"
                 "she" "her" "they" "them" "their" "who" "which" "what"
                 "if" "then" "than" "when" "where" "how" "just" "also")
             table)
      (setf (gethash w table) t)))
  "Words the brief's budgets do not count: brief.ts STOP_WORDS.")

(defun significant-p (segment)
  (and (wordish-p segment) (not (gethash (string-downcase segment) +brief-stop-words+))))

(defun flatten-for-budget (text)
  "brief.ts normalizeForTokenBudget: CR as LF, other whitespace runs as one space, at most one blank line."
  (js-trim (rx-replace (rx "\\n{3,}")
                       (rx-replace (rx "[^\\S\\n]+") (rx-replace (rx "\\r\\n?") text (string #\Newline) :all t) " " :all t)
                       (format nil "~%~%") :all t)))

(defun truncate-words (text limit)
  "TEXT cut after LIMIT significant words, marked `...(truncated)`."
  (let ((flat (flatten-for-budget text)) (count 0) (last-end 0))
    (dolist (seg (word-segments flat) flat)
      (destructuring-bind (segment start end) seg
        (declare (ignore start))
        (when (significant-p segment)
          (incf count)
          (when (> count limit)
            (return (concatenate 'string (js-trim-end (js-slice flat 0 last-end)) "...(truncated)"))))
        (setf last-end end)))))

(defun truncate-words-head-tail (text head-limit tail-limit)
  "TEXT's first HEAD-LIMIT and last TAIL-LIMIT significant words, the middle marked cut."
  (let ((flat (flatten-for-budget text)))
    (if (or (<= head-limit 0) (<= tail-limit 0))
        flat
        (let ((words (coerce (remove-if-not (lambda (s) (significant-p (first s))) (word-segments flat)) 'vector)))
          (if (<= (length words) (+ head-limit tail-limit))
              flat
              (format nil "~a~%...(middle truncated)...~%~a"
                      (js-trim-end (js-slice flat 0 (third (aref words (1- head-limit)))))
                      (js-trim-start (js-slice flat (second (aref words (- (length words) tail-limit)))))))))))

;;; --- shell commands in one line ----------------------------------------------------

(defparameter +bash-cap+ 240)
(defparameter +heredoc-body-cap+ 80)

(defun trivial-line-p (line)
  (rx-test (rx "^(?:set\\s+[-+]|cd\\s+\\S+$|export\\s+\\w+=|(?:source|\\.)\\s+\\S+|pwd$|true$|:$|#)") line))

(defun heredoc-close-index (lines i)
  "The index of the line that closes the heredoc LINES[I] opens, or -1."
  (let ((m (rx-exec (rx "(?<![\\w)])<<-?\\s*[\"']?([A-Za-z_]\\w*)[\"']?") (aref lines i))))
    (if (null m)
        -1
        (let ((term (rx-group m 1)))
          (loop for j from (1+ i) below (length lines)
                when (string= (js-trim (aref lines j)) term) return j
                finally (return -1))))))

(defun strip-cd-prefix (line) (js-trim (rx-replace (rx "^cd\\s+\\S+\\s*&&\\s*") line "")))

(defun strip-pipe-tail (line)
  (let ((c line))
    (dotimes (i 3)
      (let ((stripped (rx-replace (rx "\\s*\\|\\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\\s[^|]*)?$") c "")))
        (when (string= stripped c) (return))
        (setf c stripped)))
    (js-trim c)))

(defun cap-command (cmd)
  (if (> (js-length cmd) +bash-cap+) (concatenate 'string (js-slice cmd 0 (- +bash-cap+ 3)) "...") cmd))

(defun compress-bash (raw)
  "A shell command as one line: heredoc bodies and preamble lines dropped, `cd x &&`
and pipe tails stripped, lines joined with `; `, capped."
  (let* ((raw-lines (coerce (split-string raw #\Newline) 'vector))
         (kept (make-array 0 :adjustable t :fill-pointer t)))
    (loop with i = 0
          while (< i (length raw-lines))
          do (let ((line (aref raw-lines i)))
               (vector-push-extend line kept)
               (let ((close (heredoc-close-index raw-lines i)))
                 (when (/= close -1)
                   (let ((preview ""))
                     (unless (rx-test (rx "(?:^|[|&;]\\s*)(?:cat|tee|dd)\\b") line)
                       (loop for j from (1+ i) below close
                             while (zerop (length preview))
                             do (let ((tl (js-trim (aref raw-lines j))))
                                  (when (and (plusp (length tl))
                                             (not (rx-test (rx "^(?:import\\s|from\\s+\\S+\\s+import|require\\(|const\\s+\\w+\\s*=\\s*require|#|\\/\\/|\"\"\"|'''|\"use strict\"|use\\s+strict|<\\?php)") tl)))
                                    (setf preview tl)))))
                     (when (plusp (length preview))
                       (setf (aref kept (1- (length kept)))
                             (format nil "~a ~a" (js-trim line)
                                     (if (> (js-length preview) +heredoc-body-cap+)
                                         (concatenate 'string (js-slice preview 0 (1- +heredoc-body-cap+)) "…")
                                         preview)))))
                   (setf i close)))
               (incf i)))
    (let ((lines (remove "" (map 'list #'js-trim kept) :test #'string=)))
      (if (null lines)
          (js-trim raw)
          (let* ((meaningful (remove "" (mapcar (lambda (l) (strip-pipe-tail (strip-cd-prefix l)))
                                                (remove-if #'trivial-line-p lines))
                                     :test #'string=))
                 (chosen (or meaningful (remove "" (list (strip-pipe-tail (strip-cd-prefix (first lines)))) :test #'string=))))
            (cap-command (join-strings chosen "; ")))))))

(defun compress-code (raw)
  "A python cell as one line: its non-blank lines joined with `; `, capped."
  (cap-command (join-strings (remove "" (mapcar #'js-trim (split-string raw #\Newline)) :test #'string=) "; ")))

;;; --- one tool call in one line --------------------------------------------------

(defparameter +recall-params+ '("query" "range" "expand" "page" "scope" "mode" "session") "src/names.ts RECALL_PARAMS.")

(defun recall-arg (value)
  (if (and (vectorp value) (not (stringp value)))
      (format nil "[~a]" (join-strings (map 'list (lambda (v) (if (or (null v) (eq v :null)) "" (js-string-of v))) value) ", "))
      (js-clip (js-trim (js-string-of value)) 40)))

(defun own-tool-line (name args)
  "omp-vcc's own tools as what was recalled or pinned, or NIL for another tool."
  (cond ((own-tool-p name +recall-tool+)
         (let ((parts '()) (query (json-get args "query")))
           (when (and (stringp query) (plusp (length (js-trim query))))
             (push (format nil "\"~a\"" (js-clip query 60)) parts))
           (dolist (key +recall-params+)
             (let ((value (json-get args key)))
               (unless (or (string= key "query") (unset-p value)
                           (and (string= key "page") (eql (js-number-of value) 1)))
                 (push (format nil "~a:~a" key (recall-arg value)) parts))))
           (if parts (format nil "* ~a ~a" name (join-strings (nreverse parts) " ")) (format nil "* ~a" name))))
        ((own-tool-p name "vcc_pin")
         (let ((call (pin-call-of args)))
           (cond ((and (consp call) (eq (first call) :note)) (format nil "* ~a \"~a\"" name (js-clip (second call) 60)))
                 ((and (consp call) (eq (first call) :unpin)) (format nil "* ~a unpin:~a" name (recall-arg (second call))))
                 (t (format nil "* ~a" name)))))))

(defun tool-one-liner (name args)
  (or (own-tool-line name args)
      (let* ((call (make-call name args)) (subject (call-subject call)))
        (if (null subject)
            (format nil "* ~a" name)
            (destructuring-bind (label value more) subject
              (if (eq (call-kind call) :shell)
                  (format nil "* ~a \"~a\"" name (compress-bash value))
                  (format nil "* ~a \"~a\"~:[~; +~d~]" name (if (string= label "query") (js-clip value 60) value) (plusp more) more)))))))

;;; --- the brief -------------------------------------------------------------------
;;;
;;; A section is (HEADER . ITEMS) with ITEMS a vector of (:text S), (:call S REFS)
;;; or (:omitted N).

(defparameter +tool-calls-per-turn+ 8)

(defun tool-item-p (item) (not (eq (first item) :text)))

(defun render-item (item)
  (ecase (first item)
    (:text (second item))
    (:omitted (format nil "* (~d earlier tool-call entries omitted)" (second item)))
    (:call (let ((call (second item)) (refs (third item)))
             (cond ((null refs) call)
                   ((null (rest refs)) (format nil "~a (#~d)" call (first refs)))
                   (t (format nil "~a (~{#~d~^, ~}) x~d" call refs (length refs))))))))

(defun self-talk-stripped (text)
  (let ((raw text))
    (dotimes (i 2 raw)
      (let ((stripped (rx-replace (rx "^\\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\\s-]+" "i") raw "")))
        (when (string= stripped raw) (return raw))
        (setf raw stripped)))))

(defun segment-closing-p (blocks i)
  "The assistant block I is the last thing said before the next user turn."
  (and (eq (block-kind (aref blocks i)) :assistant)
       (let ((next (loop for j from (1+ i) below (length blocks)
                         unless (eq (block-kind (aref blocks j)) :tool-result) return (aref blocks j))))
         (or (null next) (eq (block-kind next) :user)))))

(defun build-brief-sections (block-list)
  (let ((blocks (coerce block-list 'vector)) (sections '()) (last-header ""))
    (labels ((push-item (header item)
               (if (and (string= header last-header) sections)
                   (let* ((items (cdr (first sections)))
                          (last (and (plusp (length items)) (aref items (1- (length items))))))
                     (if (and (eq (first item) :call) (third item) last (eq (first last) :call) (third last)
                              (string= (second last) (second item)))
                         (setf (third last) (append (third last) (third item)))
                         (vector-push-extend item items)))
                   (progn (push (cons header (make-array 1 :adjustable t :fill-pointer t :initial-contents (list item))) sections)
                          (setf last-header header))))
             (push-text (header text ref)
               (let ((lines (split-string text #\Newline)))
                 (setf (car (last lines)) (concatenate 'string (car (last lines)) ref))
                 (dolist (line lines) (push-item header (list :text line)))))
             (ref-of (b) (if (block-index b) (format nil " (#~d)" (block-index b)) "")))
      (dotimes (i (length blocks))
        (let ((b (aref blocks i)))
          (case (block-kind b)
            (:user
             (when (plusp (length (js-trim (block-text b))))
               (let ((text (truncate-words (collapse-skill-text (block-text b)) +truncate-user+)))
                 (when (plusp (length text)) (push-text "[user]" text (ref-of b))))
               (setf last-header "[user]")))
            (:bash
             (let ((cmd (if (equal (block-lang b) "python") (compress-code (block-command b)) (compress-bash (block-command b)))))
               (when (plusp (length cmd))
                 (push-item "[user]" (list :text (format nil "~a ~a~a~a" (if (equal (block-lang b) "python") ">>>" "$") cmd
                                                         (if (nonzero-exit-p (block-exit-code b)) " [failed]" "") (ref-of b))))))
             (setf last-header "[user]"))
            (:assistant
             (let* ((raw (self-talk-stripped (block-text b)))
                    (text (if (segment-closing-p blocks i)
                              (truncate-words-head-tail raw +closing-head-words+ +closing-tail-words+)
                              (truncate-words-head-tail raw +assistant-head-words+ +assistant-tail-words+))))
               (when (plusp (length text)) (push-text "[assistant]" text (ref-of b)))))
            (:tool-call
             (let ((name (block-name b)))
               (when (and (stringp name) (plusp (length (js-trim name))))
                 (push-item "[assistant]" (list :call (concatenate 'string (tool-one-liner name (block-args b))
                                                                    (if (block-failed b) " [failed]" ""))
                                                (if (block-index b) (list (block-index b)) '())))))))))
      (let ((sections (nreverse sections)))
        (dolist (sec sections sections)
          (when (string= (car sec) "[assistant]")
            (let ((calls (remove-if-not #'tool-item-p (coerce (cdr sec) 'list))))
              (when (> (length calls) +tool-calls-per-turn+)
                (let* ((dropped (subseq calls 0 (- (length calls) +tool-calls-per-turn+)))
                       (first-kept (nth (length dropped) calls))
                       (items (loop for item across (cdr sec)
                                    append (cond ((member item dropped :test #'eq) '())
                                                 ((eq item first-kept) (list (list :omitted (length dropped)) item))
                                                 (t (list item))))))
                  (setf (cdr sec) (coerce items 'vector)))))))))))

(defun stringify-brief (sections)
  (flet ((tools-only (sec) (and (string= (car sec) "[assistant]") (every #'tool-item-p (cdr sec)))))
    (let ((out '()) (previous nil))
      (dolist (sec sections)
        (when (and previous (not (and (tools-only previous) (tools-only sec)))) (push "" out))
        (push (car sec) out)
        (loop for item across (cdr sec) do (push (render-item item) out))
        (setf previous sec))
      (join-strings (nreverse out) (string #\Newline)))))

(defun compile-brief (blocks) (stringify-brief (build-brief-sections blocks)))

;;; --- ranking ------------------------------------------------------------------------

(defparameter +recent-blocks+ 16)
(defparameter +brief-max-blocks+ 80 "window.ts DEFAULT_BUDGETS.briefMaxBlocks.")
(defparameter +trivial-bash-penalty+ 16)

(defun test-command-p (s) (rx-test (rx "\\b(?:bun|npm|pnpm|yarn|node|pytest|cargo|go|mvn|gradle)\\b[^\\n]*(?:test|spec|check|lint|build|tsc)" "i") s))
(defun workflow-command-p (s)
  (rx-test (rx "(?:^|\\s)(?:gh\\s+(?:pr|issue)\\s+[a-z-]+|git\\s+(?:commit|push|merge|rebase|revert|cherry-pick|tag|reset|checkout|branch)\\b)" "i") s))

(defun trivial-only-bash-p (raw)
  "Every meaningful line of RAW is scaffolding (set -e, cd, ls, echo, comments), heredoc bodies aside."
  (let* ((lines (coerce (split-string raw #\Newline) 'vector)) (kept '()))
    (loop with i = 0 while (< i (length lines))
          do (push (aref lines i) kept)
             (let ((close (heredoc-close-index lines i))) (when (/= close -1) (setf i close)))
             (incf i))
    (notany (lambda (l) (and (plusp (length l))
                             (not (trivial-line-p l))
                             (not (rx-test (rx "^(?:cd$|ls(?:\\s|$)|echo\\b|clear$|sleep\\b)") l))))
            (mapcar #'js-trim kept))))

(defun ran-code (b) (if (eq (block-kind b) :bash) (block-command b) (command-of b)))

(defun path-from-block (b)
  (case (block-kind b)
    (:tool-call (first (files-of (block-call b))))
    (:bash (let ((m (rx-exec (rx "(?:^|\\s)([\\w./-]+\\.[\\w-]+)(?:\\s|$)") (block-command b)))) (and m (rx-group m 1))))))

(defstruct (ranked (:constructor make-ranked (block index))) block index (score 0) (reasons '()))

(defun award (r points reason) (incf (ranked-score r) points) (push reason (ranked-reasons r)))

(defun score-block (b index total modified read)
  (let ((r (make-ranked b index)))
    (award r (if (<= total 1) 0 (js-round (* (/ (coerce index 'double-float) (- total 1)) 12))) "recency")
    (case (block-kind b)
      (:user (award r 18 "user-turn"))
      (:assistant (award r 10 "assistant-context"))
      (:tool-result (award r 1 "tool-result-low-value")))
    (when (eq (block-kind b) :tool-call)
      (let ((command (command-of b)) (kind (call-kind (block-call b))))
        (cond ((member kind '(:edit :write)) (award r 34 "edit-tool"))
              ((and command (test-command-p command)) (award r 26 "test-command"))
              ((member kind '(:read :search)) (award r 6 "read-tool"))
              (t (award r 12 "tool-call")))
        (when (and command (workflow-command-p command)) (award r 14 "workflow-command"))
        (cond ((block-failed b) (award r 24 "failed-call"))
              ((and command (plusp (length command)) (trivial-only-bash-p command)) (award r (- +trivial-bash-penalty+) "trivial-bash")))))
    (when (eq (block-kind b) :bash)
      (award r 8 "bash")
      (let ((nonzero (nonzero-exit-p (block-exit-code b))))
        (when nonzero (award r 24 "nonzero-exit"))
        (when (test-command-p (block-command b)) (award r 22 "test-command"))
        (when (workflow-command-p (block-command b)) (award r 14 "workflow-command"))
        (when (and (trivial-only-bash-p (block-command b)) (not nonzero)) (award r (- +trivial-bash-penalty+) "trivial-bash"))))
    (let ((path (path-from-block b)))
      (when path
        (when (gethash path modified) (award r 18 "hook-modified-file"))
        (when (gethash path read) (award r 6 "hook-read-file"))))
    (when (and (eq (block-kind b) :tool-result) (> (js-length (block-text b)) 1000)) (award r -8 "long-tool-result"))
    r))

(defun rank-brief-blocks (blocks file-ops)
  (let* ((modified (path-set (json-get file-ops "changed")))
         (read (path-set (json-get file-ops "read")))
         (ranked (coerce (loop for b across blocks for i from 0 collect (score-block b i (length blocks) modified read)) 'vector)))
    (flet ((has (r reason) (member reason (ranked-reasons r) :test #'string=)))
      (dolist (idx (loop for r across ranked
                         when (or (>= (ranked-score r) 34) (has r "edit-tool") (has r "test-command") (has r "nonzero-exit") (has r "failed-call"))
                           collect (ranked-index r)))
        (loop for i from (1- idx) downto (max 0 (- idx 8))
              when (eq (block-kind (ranked-block (aref ranked i))) :user) do (award (aref ranked i) 10 "near-important-event") (return))
        (loop for i from (1- idx) downto (max 0 (- idx 4))
              when (eq (block-kind (ranked-block (aref ranked i))) :assistant) do (award (aref ranked i) 7 "near-important-event") (return))
        (loop for i from (1+ idx) to (min (1- (length ranked)) (+ idx 4))
              when (member (block-kind (ranked-block (aref ranked i))) '(:assistant :bash)) do (award (aref ranked i) 5 "after-important-event") (return))))
    (dotimes (i (length ranked))
      (let ((b (ranked-block (aref ranked i))))
        (when (and (eq (block-kind b) :assistant) (>= (js-length (js-trim (block-text b))) 120)
                   (let ((next (loop for j from (1+ i) below (length ranked)
                                     unless (eq (block-kind (ranked-block (aref ranked j))) :tool-result)
                                       return (ranked-block (aref ranked j)))))
                     (or (null next) (eq (block-kind next) :user))))
          (award (aref ranked i) 14 "segment-closing-assistant"))))
    ranked))

(defun path-set (paths)
  (let ((set (make-hash-table :test 'equal)))
    (when (and (vectorp paths) (not (stringp paths)))
      (loop for p across paths when (and (stringp p) (plusp (length p))) do (setf (gethash p set) t)))
    set))

(defun dedup-key (b)
  (let* ((command (ran-code b))
         (poll (and command (rx-exec (rx "(?:^|\\s)gh\\s+pr\\s+(?:view|checks)\\s+(\\d+)\\b" "i") command))))
    (cond (poll (format nil "gh-pr-poll:~a" (rx-group poll 1)))
          ((and command (plusp (length command)))
           (let ((normalized (js-trim (collapse-whitespace command))))
             (and (plusp (length normalized)) (format nil "bash:~a" normalized))))
          ((eq (block-kind b) :tool-call)
           (let ((subject (call-subject (block-call b))))
             (and subject (format nil "tool:~a:~a" (string-downcase (block-name b)) (second subject))))))))

(defun select-ranked-brief-blocks (block-list ranking file-ops)
  "The blocks the brief covers: rank.ts selectRankedBriefBlocks, RANKING its
options (maxBlocks, preserveRecentBlocks, maxBriefChars and its ceiling and slope)."
  (let* ((blocks (coerce block-list 'vector))
         (n (length blocks))
         (max-blocks (let ((m (json-get ranking "maxBlocks"))) (if (integerp m) m +brief-max-blocks+)))
         (floor (json-get ranking "maxBriefChars"))
         (ceiling (json-get ranking "maxBriefCharsCeiling"))
         (slope (json-get ranking "briefCharsPerBlock"))
         (budget (if (and (realp floor) (realp ceiling) (realp slope))
                     (js-round (min ceiling (max floor (* slope n))))
                     (and (realp floor) floor))))
    (if (and (<= n max-blocks) (null budget))
        block-list
        (let* ((preserve (min (let ((p (json-get ranking "preserveRecentBlocks"))) (if (integerp p) p +recent-blocks+)) max-blocks))
               (ranked (rank-brief-blocks blocks file-ops))
               (selected (make-hash-table)) (seen (make-hash-table :test 'equal))
               (costs (and budget (map 'vector (lambda (b) (if (eq (block-kind b) :tool-result) 0 (1+ (js-length (compile-brief (list b)))))) blocks)))
               (used 0))
          (loop for i from (1- n) downto (max 0 (- n preserve))
                do (let ((b (aref blocks i)))
                     (unless (or (eq (block-kind b) :tool-result) (gethash i selected)
                                 (and costs (> (+ used (aref costs i)) budget)))
                       (setf (gethash i selected) t)
                       (when costs (incf used (aref costs i)))
                       (let ((key (dedup-key b))) (when key (setf (gethash key seen) t))))))
          (let ((ordered (stable-sort (copy-seq ranked)
                                      (lambda (a b) (or (> (ranked-score a) (ranked-score b))
                                                        (and (= (ranked-score a) (ranked-score b)) (> (ranked-index a) (ranked-index b))))))))
            (loop for item across ordered
                  do (when (>= (hash-table-count selected) max-blocks) (return))
                     (let ((i (ranked-index item)) (b (ranked-block item)))
                       (unless (or (gethash i selected) (eq (block-kind b) :tool-result))
                         (let ((key (dedup-key b)))
                           (unless (and key (gethash key seen))
                             (unless (and costs (> (+ used (aref costs i)) budget))
                               (when costs (incf used (aref costs i)))
                               (setf (gethash i selected) t)
                               (when key (setf (gethash key seen) t)))))))))
          (loop for i below n when (gethash i selected) collect (aref blocks i))))))
