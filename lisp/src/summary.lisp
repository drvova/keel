;;;; summary.lisp --- a compaction's summary, and what it stores for the next.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/summarize.ts compileSummary and what it is made of:
;;;; format.ts (renderSummary, the only place summary text is written),
;;;; summary-state.ts (this window's sections, merged into the state the
;;;; previous compaction stored, never re-written from its text),
;;;; legacy-summary.ts (a previous summary that has no stored state, read from
;;;; its text once, in a frozen copy of the format it was written in), and the
;;;; [Pinned Notes] and [History Index] lines (pins.ts, history-index.ts).

(in-package #:omp-vcc)

(defparameter +separator+ (format nil "~%~%---~%~%") "Between the header, the brief and the recall note.")
(defparameter +recall-note+
  "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.")
(defparameter +command-separator+ " | ")
(defparameter +tracked-entry-chars+ 80)
(defparameter +tui-line-chars+ 120 "format.ts TUI_SAFE_LINE_CHARS.")

(defun last-n (list n)
  "LIST's last N items, as Array.slice(-N) gives them (all of it for N 0)."
  (if (or (<= n 0) (>= n (length list))) list (last list n)))

(defun nl () (string #\Newline))

;;; --- wrapping and capping -----------------------------------------------------------

(defun wrap-line (line max)
  (if (<= (js-length line) max)
      (list line)
      (let* ((indent (rx-group (rx-exec (rx "^\\s*(?:[-*]\\s+|\\d+\\.\\s+)?") line)))
             (continuation (if (plusp (length indent)) (make-string (min (js-length indent) 8) :initial-element #\Space) ""))
             (out '()) (remaining line) (prefix ""))
        (loop while (> (+ (js-length prefix) (js-length remaining)) max)
              do (let* ((available (max 20 (- max (js-length prefix))))
                        (split (js-last-index-of " " remaining available)))
                   (when (< split (floor (* available 0.5d0))) (setf split available))
                   (push (concatenate 'string prefix (js-trim-end (js-slice remaining 0 split))) out)
                   (setf remaining (js-trim-start (js-slice remaining split))
                         prefix continuation)))
        (when (plusp (length remaining)) (push (concatenate 'string prefix remaining) out))
        (nreverse out))))

(defun wrap-long-lines (text &optional (max +tui-line-chars+))
  "TEXT's lines wrapped for the hosts' TUI, which shows a summary as written."
  (join-strings (mapcan (lambda (line) (wrap-line line max)) (split-string text #\Newline)) (nl)))

(defun cap-brief (text max-lines)
  "A brief's last MAX-LINES lines, from a block's header, behind a count of the lines left out."
  (if (or (zerop (length text)) (<= max-lines 0))
      ""
      (let ((lines (split-string text #\Newline)))
        (if (<= (length lines) max-lines)
            text
            (let* ((kept (last lines max-lines))
                   (header (position-if (lambda (l) (rx-test (rx "^\\[.+\\]") l)) kept))
                   (clean (if (and header (> header 0)) (nthcdr header kept) kept)))
              (format nil "...(~d earlier lines omitted)~%~%~a" (- (length lines) (length clean)) (join-strings clean (nl))))))))

(defun cap-items (items limit separator)
  (if (<= (length items) limit)
      (join-strings items separator)
      (format nil "(+~d earlier) ~a" (- (length items) limit) (join-strings (last-n items limit) separator))))

(defun tracked-entry (entry)
  (let ((line (rx-replace (rx " \\| ") (collapse-whitespace entry) " \\| " :all t)))
    (if (> (js-length line) +tracked-entry-chars+) (concatenate 'string (js-slice line 0 +tracked-entry-chars+) "…") line)))

(defun common-dir (paths)
  "The longest directory two or more absolute PATHS share (at least /a/b/), or \"\"."
  (let ((abs (remove-if-not (lambda (p) (starts-with "/" p)) paths)))
    (if (< (length abs) 2)
        ""
        (let* ((split (mapcar (lambda (p) (coerce (split-string p #\/) 'vector)) abs))
               (min (reduce #'min (mapcar #'length split)))
               (i 0))
          (loop while (and (< i (1- min)) (every (lambda (s) (string= (aref s i) (aref (first split) i))) split))
                do (incf i))
          (if (< i 2) "" (concatenate 'string (join-strings (coerce (subseq (first split) 0 i) 'list) "/") "/"))))))

(defun section (title items)
  (if (null items) "" (format nil "[~a]~%~a" title (join-strings (mapcar (lambda (i) (concatenate 'string "- " i)) items) (nl)))))

;;; --- the state ----------------------------------------------------------------------

(defstruct (state (:constructor make-state
                      (&key early-requests early-slots modified created read commits tracked user-messages (brief ""))))
  early-requests early-slots modified created read commits tracked user-messages brief)

(defun strings-of (v) (if (and (vectorp v) (not (stringp v))) (remove-if-not #'stringp (coerce v 'list)) '()))

(defun state-from-json (v)
  "A state the TS side read and checked (summary-state.ts readState)."
  (let ((files (json-get v "files")))
    (make-state :early-requests (strings-of (json-get v "earlyRequests"))
                :early-slots (json-get v "earlySlots")
                :modified (strings-of (json-get files "modified"))
                :created (strings-of (json-get files "created"))
                :read (strings-of (json-get files "read"))
                :commits (map 'list (lambda (c) (make-commit (json-get c "message") (let ((h (json-get c "hash"))) (and (stringp h) h))))
                              (json-get v "commits" #()))
                :tracked (map 'list (lambda (tr) (cons (json-get tr "name") (strings-of (json-get tr "entries")))) (json-get v "tracked" #()))
                :user-messages (strings-of (json-get v "userMessages"))
                :brief (string-or (json-get v "brief") ""))))

(defun state-json (s)
  (json-object "earlyRequests" (coerce (state-early-requests s) 'vector)
               "earlySlots" (state-early-slots s)
               "files" (json-object "modified" (coerce (state-modified s) 'vector)
                                    "created" (coerce (state-created s) 'vector)
                                    "read" (coerce (state-read s) 'vector))
               "commits" (map 'vector (lambda (c) (json-object "hash" (commit-hash c) "message" (commit-message c))) (state-commits s))
               "tracked" (map 'vector (lambda (tr) (json-object "name" (car tr) "entries" (coerce (cdr tr) 'vector))) (state-tracked s))
               "userMessages" (coerce (state-user-messages s) 'vector)
               "brief" (state-brief s)))

(defun fresh-state (blocks brief-blocks file-ops track-commands early-slots)
  "This window's sections: summary-state.ts freshState."
  (let* ((messages (extract-user-messages blocks))
         (early (subseq messages 0 (min (length messages) (max 0 early-slots)))))
    (multiple-value-bind (read modified created) (extract-files blocks file-ops)
      (make-state :early-requests early
                  :early-slots (max 0 (- early-slots (length early)))
                  :modified modified :created created :read read
                  :commits (extract-commits blocks)
                  :tracked (remove-if (lambda (tr) (null (cdr tr))) (extract-tracked-commands blocks track-commands))
                  :user-messages (nthcdr (length early) messages)
                  :brief (wrap-long-lines (compile-brief brief-blocks))))))

(defun append-touched (items more)
  "ITEMS and then MORE, a repeated item moved to the end."
  (let ((out (copy-list items)))
    (dolist (item more out)
      (setf out (append (remove item out :test #'string= :count 1) (list item))))))

(defun merge-brief (prev fresh max-lines)
  (cond ((zerop (length prev)) fresh)
        ((zerop (length fresh)) (cap-brief prev max-lines))
        (t (let* ((room (- max-lines (length (split-string fresh #\Newline))))
                  (tail (if (> room 0) (cap-brief prev room) "")))
             (if (plusp (length tail)) (format nil "~a~%~%~a" tail fresh) fresh)))))

(defun merge-states (prev fresh limits)
  "The previous summary's sections with this window's merged in: summary-state.ts mergeStates."
  (if (null prev)
      fresh
      (let* ((created-before (state-created prev))
             (existed-before (append (state-read prev) (state-modified prev)))
             (modified (append-touched (state-modified prev) (state-modified fresh)))
             (created (append-touched (state-created prev) (state-created fresh))))
        ;; One rule for whether a file existed before it was written (summary-state.ts).
        (dolist (p (remove-duplicates (append (remove-if-not (lambda (p) (member p modified :test #'string=)) created)
                                              (remove-if-not (lambda (p) (member p existed-before :test #'string=)) (state-created fresh)))
                                      :test #'string= :from-end t))
          (if (member p created-before :test #'string=)
              (setf modified (remove p modified :test #'string=))
              (progn (setf created (remove p created :test #'string=))
                     (unless (member p modified :test #'string=) (setf modified (append-touched modified (list p)))))))
        (let ((tracked (mapcar (lambda (tr) (cons (car tr) (copy-list (cdr tr)))) (state-tracked prev))))
          (dolist (tr (state-tracked fresh))
            (let ((at (assoc (car tr) tracked :test #'string=)))
              (if at
                  (setf (cdr at) (append-touched (cdr at) (cdr tr)))
                  (setf tracked (append tracked (list (cons (car tr) (copy-list (cdr tr)))))))))
          (make-state :early-requests (let ((all (remove-duplicates (append (state-early-requests prev) (state-early-requests fresh))
                                                                    :test #'string= :from-end t)))
                                        (subseq all 0 (min 3 (length all))))
                      :early-slots (state-early-slots fresh)
                      :modified modified :created created
                      :read (append-touched (state-read prev) (state-read fresh))
                      :commits (let ((out '())) (dolist (c (append (state-commits prev) (state-commits fresh)) out)
                                                  (setf out (add-commit out c))))
                      :tracked tracked
                      :user-messages (append-touched (state-user-messages prev) (state-user-messages fresh))
                      :brief (merge-brief (state-brief prev) (state-brief fresh) (limit limits "briefLines")))))))

(defun limit (limits key) (json-get limits key))

(defun cap-state (s limits)
  "What a summary shows of each list, which is what it stores: summary-state.ts capState."
  (let ((per (limit limits "filesPerCategory")))
    (make-state :early-requests (subseq (state-early-requests s) 0 (min 3 (length (state-early-requests s))))
                :early-slots (state-early-slots s)
                :modified (last-n (state-modified s) per) :created (last-n (state-created s) per) :read (last-n (state-read s) per)
                :commits (last-n (state-commits s) (limit limits "commits"))
                :tracked (mapcar (lambda (tr) (cons (car tr) (last-n (cdr tr) (limit limits "commandsPerName")))) (state-tracked s))
                :user-messages (last-n (state-user-messages s) (limit limits "userMessages"))
                :brief (state-brief s))))

;;; --- the text ----------------------------------------------------------------------

(defun file-lines (s per)
  (let* ((shown (append (last-n (state-modified s) per) (last-n (state-created s) per) (last-n (state-read s) per)))
         (dir (common-dir shown)))
    (flet ((trim (p) (if (and (plusp (length dir)) (starts-with dir p)) (subseq p (length dir)) p)))
      (loop for (label list) in (list (list "Modified" (state-modified s)) (list "Created" (state-created s)) (list "Read" (state-read s)))
            when list collect (format nil "~a: ~a" label (cap-items (mapcar #'trim list) per ", "))))))

(defun render-summary (s limits pins history working-set)
  "The summary's text and the sections it shows: format.ts renderSummary."
  (let* ((parts (list (list "Pinned Notes" (section "Pinned Notes" pins))
                      (list "Early Session Requests" (section "Early Session Requests" (state-early-requests s)))
                      (list "Files And Changes" (section "Files And Changes" (file-lines s (limit limits "filesPerCategory"))))
                      (list "Commits" (section "Commits" (mapcar (lambda (c) (if (commit-hash c) (format nil "~a: ~a" (commit-hash c) (commit-message c)) (commit-message c)))
                                                                 (last-n (state-commits s) (limit limits "commits")))))
                      (list "Tracked Commands" (section "Tracked Commands" (mapcar (lambda (tr) (format nil "~a: ~a" (car tr) (cap-items (mapcar #'tracked-entry (cdr tr)) (limit limits "commandsPerName") +command-separator+)))
                                                                                   (state-tracked s))))
                      (list "User Messages" (section "User Messages" (last-n (state-user-messages s) (limit limits "userMessages"))))
                      (list "History Index" (section "History Index" history))))
         (shown (remove-if (lambda (p) (zerop (length (second p)))) parts))
         (ws (if working-set (format nil "[Working Set]~%~a" (join-strings working-set (nl))) ""))
         (head (join-strings (remove "" (list (wrap-long-lines (join-strings (mapcar #'second shown) (format nil "~%~%"))) ws) :test #'string=)
                             (format nil "~%~%"))))
    (if (and (zerop (length head)) (zerop (length (state-brief s))))
        (values "" '())
        (values (concatenate 'string (join-strings (remove "" (list head (state-brief s)) :test #'string=) +separator+)
                             +separator+ (wrap-long-lines +recall-note+))
                (append (mapcar #'first shown) (and working-set (list "Working Set")))))))

;;; --- a summary from before the state was stored ------------------------------------------
;;;
;;; The text older versions wrote, as they wrote it: frozen here.

(defun recall-note-regex ()
  (load-time-value
   (compile-regex (format nil "\\n*(?:---\\n+)?~a\\n*"
                          (join-strings (mapcar #'escape-regex (remove "" (rx-split (compile-regex "\\s+" :ignore-case nil) +recall-note+) :test #'string=))
                                        "\\s+"))
                  :ignore-case nil)
   t))

(defun split-summary (text)
  "(values HEAD BRIEF): legacy-summary.ts splitSummary."
  (if (not (rx-test (rx "^\\[[A-Z][^\\]\\n]*\\]$") (first (split-string text #\Newline))))
      (values "" (js-trim text))
      (let ((idx (js-index-of +separator+ text)))
        (if (< idx 0)
            (values text "")
            (values (js-slice text 0 idx) (js-trim (js-slice text (+ idx (js-length +separator+)))))))))

(defun section-of (text header)
  (let* ((lines (coerce (split-string (split-summary text) #\Newline) 'vector))
         (start (position (format nil "[~a]" header) lines :test #'string=)))
    (if (null start)
        ""
        (let ((end (1+ start)))
          (loop while (and (< end (length lines)) (plusp (length (js-trim (aref lines end))))) do (incf end))
          (js-trim (join-strings (coerce (subseq lines start end) 'list) (nl)))))))

(defun brief-of (text) (nth-value 1 (split-summary text)))

(defun section-items (text header)
  (loop for l in (split-string (rx-replace (rx "\\n[ \\t]+(?=\\S)") (section-of text header) " " :all t) #\Newline)
        when (and (starts-with "- " l) (not (search "<skill" l)) (not (search "</skill" l)))
          collect (subseq l 2)))

(defun without-count (text)
  (rx-replace (rx "\\s*\\(\\+\\d+ (?:more|earlier)\\)\\s*$") (rx-replace (rx "^\\s*\\(\\+\\d+ earlier\\)\\s*") text "") ""))

(defun listed (lines separator)
  (loop for line in lines
        for m = (rx-exec (rx "^([^:]+): (.*)$") line)
        when m collect (cons (rx-group m 1)
                             (remove "" (mapcar #'js-trim (split-on (without-count (rx-group m 2)) separator)) :test #'string=))))

(defun split-on (text separator)
  "TEXT split at every SEPARATOR string: String.split with a string."
  (let ((parts '()) (start 0) (n (length separator)))
    (loop for at = (search separator text :start2 start)
          while at do (push (subseq text start at) parts) (setf start (+ at n)))
    (push (subseq text start) parts)
    (nreverse parts)))

(defun legacy-previous (summary foreign)
  "An older summary's text as state: legacy-summary.ts legacyPrevious."
  (let* ((text (js-trim-end (rx-replace (recall-note-regex) summary (format nil "~%~%") :all t)))
         (early (section-items text "Early Session Requests"))
         (goal (and (null early)
                    (find-if-not (lambda (l) (rx-test (rx "^\\[[^\\]]*\\]$") l)) (section-items text "Session Goal"))))
         (goal (and goal (plusp (length goal)) goal))
         (early-requests (cond (early (subseq early 0 (min 3 (length early)))) (goal (list goal)) (t '())))
         (slots (cond ((plusp (length (section-of text "Early Session Requests"))) (- 3 (length early-requests)))
                      (goal 0) (t 3)))
         (files (listed (section-items text "Files And Changes") ", ")))
    (flet ((files-of-label (label) (or (cdr (find label files :key #'car :test #'string= :from-end t)) '())))
      (make-state :early-requests early-requests
                  :early-slots (if foreign 0 (max 0 slots))
                  :modified (files-of-label "Modified") :created (files-of-label "Created") :read (files-of-label "Read")
                  :commits (mapcar (lambda (l) (let ((m (rx-exec (rx "^([0-9a-f]{7,12}): (.*)$") l)))
                                                 (if m (make-commit (rx-group m 2) (rx-group m 1)) (make-commit l))))
                                   (section-items text "Commits"))
                  :tracked (listed (section-items text "Tracked Commands") +command-separator+)
                  :user-messages (section-items text "User Messages")
                  :brief (wrap-long-lines (brief-of text))))))

(defun with-full-paths (previous fresh)
  "An older summary's shortened paths as the one absolute path of this window each names."
  (let ((absolute (remove-duplicates (remove-if-not (lambda (p) (starts-with "/" p))
                                                    (append (state-modified fresh) (state-created fresh) (state-read fresh)))
                                     :test #'string= :from-end t)))
    (flet ((full (p) (if (starts-with "/" p)
                         p
                         (let ((matches (remove-if-not (lambda (a) (ends-with (concatenate 'string "/" p) a)) absolute)))
                           (if (= (length matches) 1) (first matches) p)))))
      (let ((s (copy-state previous)))
        (setf (state-modified s) (mapcar #'full (state-modified s))
              (state-created s) (mapcar #'full (state-created s))
              (state-read s) (mapcar #'full (state-read s)))
        s))))

;;; --- [Pinned Notes] and [History Index] lines -------------------------------------------

(defparameter +pins-shown+ 20)

(defun pin-lines (notes)
  (let* ((shown (last-n notes +pins-shown+)) (hidden (- (length notes) (length shown))))
    (append (and (plusp hidden) (list (format nil "(+~d older pinned notes; vcc_pin lists them all)" hidden)))
            (mapcar (lambda (n) (format nil "[~a] ~a (~a~@[, #~a~])" (js-string-of (json-get n "id")) (json-get n "text")
                                        (js-string-of (json-get n "by"))
                                        (let ((at (json-get n "at"))) (and at (not (eq at :null)) (js-string-of at)))))
                    shown))))

(defun plural (n one) (format nil "~d ~a~a" n one (if (= n 1) "" "s")))

(defun history-files (files)
  (if (<= (length files) 3)
      (format nil "changed ~a" (join-strings (mapcar (lambda (p) (join-strings (last (split-string p #\/) 2) "/")) files) ", "))
      (let* ((dirs (remove-duplicates (mapcar (lambda (p) (let ((parts (remove "" (split-string p #\/) :test #'string=)))
                                                            (if (> (length parts) 1) (nth (- (length parts) 2) parts) ".")))
                                              files)
                                      :test #'string= :from-end t)))
        (format nil "changed ~a files in ~a~a" (if (>= (length files) 24) (format nil "~d+" (length files)) (length files))
                (join-strings (subseq dirs 0 (min 6 (length dirs))) ", ") (if (> (length dirs) 6) ", …" "")))))

(defun history-line (r)
  "One [History Index] range: history-index.ts formatHistoryRange."
  (let ((parts '()) (requests (json-get r "requests")) (files (strings-of (json-get r "files")))
        (commits (strings-of (json-get r "commits"))) (count (json-get r "commitCount")) (failed (json-get r "failed")))
    (cond ((or (null requests) (eq requests :null)) (push "earlier, not indexed; search it with vcc_recall" parts))
          ((and (realp requests) (> requests 0))
           (push (format nil "~a: ~a" (plural requests "request")
                         (join-strings (mapcar (lambda (a) (format nil "\"~a\"" a)) (subseq (strings-of (json-get r "asks")) 0 (min 1 (length (strings-of (json-get r "asks")))))) ", "))
                 parts)))
    (when files (push (history-files files) parts))
    (when (and (realp count) (> count 0))
      (let ((last (if commits (car (last commits)) "undefined")))
        (push (if (= count 1) (format nil "1 commit: ~a" last) (format nil "~d commits, last ~a" count last)) parts)))
    (when (and (realp failed) (> failed 0)) (push (plural failed "failed call") parts))
    (format nil "#~a–#~a~:[~;: ~a~]" (js-string-of (json-get r "from")) (js-string-of (json-get r "to")) parts (join-strings (nreverse parts) " · "))))

;;; --- compileSummary --------------------------------------------------------------------

(defun compile-summary (input)
  "The summary of a window and the state to store: summarize.ts compileSummary.
INPUT is its CompileInput as JSON. Returns (values TEXT STATE SECTIONS)."
  (let* ((limits (json-get input "limits"))
         (blocks (summary-blocks (json-get input "messages" #())
                                 (let ((ix (json-get input "sourceIndices"))) (and (vectorp ix) (not (stringp ix)) ix))))
         (stored (let ((p (json-get input "previous"))) (and (json-object-p p) (state-from-json p))))
         (previous-summary (let ((s (json-get input "previousSummary"))) (and (stringp s) (plusp (length s)) s)))
         (legacy (and (null stored) previous-summary
                      (legacy-previous previous-summary (eq (json-get input "previousSummaryForeign") :true))))
         (previous (or stored legacy))
         (file-ops (json-get input "fileOps"))
         (fresh (fresh-state blocks
                             (select-ranked-brief-blocks blocks (json-get input "ranking") file-ops)
                             file-ops
                             (strings-of (json-get input "trackCommands"))
                             (if previous (state-early-slots previous) +early-requests-kept+)))
         (merged (merge-states (if legacy (with-full-paths legacy fresh) previous) fresh limits))
         (pins (let ((notes (json-get input "pinnedNotes"))) (and (vectorp notes) (plusp (length notes)) (pin-lines (coerce notes 'list)))))
         (history (let ((h (json-get input "historyIndex"))) (and (vectorp h) (map 'list #'history-line h))))
         (working-set (let ((w (strings-of (json-get input "workingSet")))) w)))
    (multiple-value-bind (text sections) (render-summary merged limits pins history working-set)
      (values text (cap-state merged limits) sections))))
