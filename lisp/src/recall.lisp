;;;; recall.lisp --- one keel_recall call: a session read once, one action run.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Every action (a range, expand, search, #N:path, mode:'touched', the
;;;; project's sessions) and the views they read through, for the tool and the
;;;; command alike (src/register.ts asks, op tool or command). The host's part comes in with
;;;; the call: the session file and its directory, the
;;;; project's other session files newest first, the working directory, and the
;;;; session manager's current branch (its ids, and its entries' types and roles
;;;; for the turn in progress). Agents act on the output: it is an interface.

(in-package #:keel)

(defparameter +recent-count+ 25)
(defparameter +min-recall-output-chars+ (* 8 1024))
(defparameter +expand-detail-chars+ 4000)
(defparameter +sessions-page-size+ 10)
(defparameter +touched-page-size+ 5)
(defparameter +project-search-sessions+ 20)
(defparameter +project-search-bytes+ (* 24 1024 1024))
(defparameter +project-search-entries+ 40000)
(defparameter +off-path-note+
  (format nil "Nothing on the current conversation path; showing edited or retried branches (scope:'all').~%~%"))

(defun recall-output-chars (window)
  (if (and (realp window) (> window 0))
      (max +min-recall-output-chars+ (min +recall-output-chars+ (js-round (* window 4 0.1d0))))
      +recall-output-chars+))

(defun expand-detail-chars (max) (max 1 (js-round (/ (* max +expand-detail-chars+) +recall-output-chars+))))

(defun kb (chars) (format nil "~d KB" (js-round (/ chars 1024))))

(defun cap-output (text max)
  (if (<= (js-length text) max)
      text
      (let* ((code (js-code-unit text (1- max)))
             (end (if (and code (<= #xD800 code #xDBFF)) (1- max) max)))
        (format nil "Warning: output clipped at ~d of ~d chars (one recall result is capped at ~a). Ask for less at once: fewer expand indices, a narrower query, or a line range for file content ('#N:path:offset:limit').~%~%~a~%...[clipped at ~a]"
                end (js-length text) (kb max) (js-slice text 0 end) (kb max)))))

;;; --- a view: one session, read once, on a scope -------------------------------------

(defstruct (view (:constructor %make-view))
  scope file session lineage project max-chars detail-chars read-cell cache wide turn-cell turn-fn)

(defun view-read (v)
  "The view's file, read once for every view of it: (MESSAGES BRANCH-IDS)."
  (let ((cell (view-read-cell v)))
    (or (car cell) (setf (car cell) (multiple-value-list (read-session (view-file v)))))))

(defun via (v) (with-params (session-param (and (view-session v) (session-info-short (view-session v))))))

(defun view-load (v full)
  "The view's messages as recall shows them: a list of plists :index :id :message :role :summary :files :session."
  (or (gethash full (view-cache v))
      (setf (gethash full (view-cache v))
            (let ((lineage (view-lineage v)))
              (loop for (index id message) in (first (view-read v))
                    when (or (null lineage) (and id (gethash id lineage)))
                      collect (destructuring-bind (role summary files) (render-entry message full index (view-detail-chars v) (via v))
                                (list :index index :id id :message message :role role :summary summary :files files)))))))

;;; --- superseded entries ------------------------------------------------------------
;;;
;;; A read of a file that was changed later shows content that no longer
;;; holds; a failed run that later passed is no longer open. DCPM (Hy-Memory 1.0,
;;; Tencent, arXiv:2606.09483) links a fact to the one that supersedes it
;;; instead of deleting it, and removing those links cost it 2.9 points; it has
;;; an LLM decide what supersedes what. Here the key decides, with no model: the
;;; same file changed later (calls.lisp files-of, changes-p), the same run passed
;;; later (run-of). Recall says so on the entry's line.

(defun superseded-notes (v)
  "Each entry of V's session that something later superseded, to a note saying what and where."
  (let ((notes (make-hash-table)) (by-id (make-hash-table :test 'equal)) (result-of (make-hash-table :test 'equal))
        (changes '()) (passes '()) (on-file '()) (fails '()))
    (dolist (e (view-load v nil))
      (let ((n (getf e :index)) (m (getf e :message)))
        (cond ((equal (json-get m "role") "assistant")
               (dolist (c (tool-calls-of m))
                 (when (call-id c) (setf (gethash (call-id c) by-id) (cons n c)))
                 (when (changes-p c) (dolist (p (files-of c)) (push (cons p n) changes)))
                 (when (on-file-p c) (dolist (p (files-of c)) (push (list p n (call-id c)) on-file)))))
              ((equal (json-get m "role") "toolResult")
               (let ((hit (gethash (json-get m "toolCallId") by-id)))
                 (when hit
                   (setf (gethash (json-get m "toolCallId") result-of) n)
                   (if (eq (json-get m "isError") :true)
                       (push (list (run-of (cdr hit)) n (car hit)) fails)
                       (push (cons (run-of (cdr hit)) n) passes))))))))
    (flet ((note (ns text) (dolist (n ns) (when (and n (not (gethash n notes))) (setf (gethash n notes) text))))
           (first-after (n pairs key) (loop for (k . at) in pairs when (and (equal k key) (> at n)) minimize at)))
      (loop for (path n id) in on-file
            for m = (first-after n changes path)
            when (plusp m) do (note (list n (gethash id result-of)) (format nil "superseded: ~a changed at #~d" path m)))
      (loop for (run n call-n) in fails
            for m = (first-after n passes run)
            when (plusp m) do (note (list n call-n) (format nil "fixed: passed at #~d" m))))
    notes))

(defun view-message (v index)
  (third (find index (first (view-read v)) :key #'first)))

(defun open-view (file scope lineage &key project session max-chars detail-chars read-cell turn-fn)
  (%make-view :scope scope :file file :session session :lineage (and (not (equal scope "all")) lineage)
              :project project :max-chars (or max-chars +recall-output-chars+)
              :detail-chars (or detail-chars (expand-detail-chars (or max-chars +recall-output-chars+)))
              :read-cell (or read-cell (list nil)) :cache (make-hash-table) :turn-fn turn-fn :turn-cell (list nil nil)))

(defun view-widen (v)
  (if (equal (view-scope v) "all")
      v
      (or (view-wide v)
          (setf (view-wide v) (open-view (view-file v) "all" nil :project (view-project v) :session (view-session v)
                                         :max-chars (view-max-chars v) :detail-chars (view-detail-chars v)
                                         :read-cell (view-read-cell v) :turn-fn (view-turn-fn v))))))

(defun view-current-turn (v)
  (let ((cell (view-turn-cell v)))
    (if (second cell) (first cell)
        (setf (second cell) t (first cell) (if (and (view-turn-fn v) (null (view-session v))) (funcall (view-turn-fn v) v) '())))))

(defun ids-set (ids) (let ((h (make-hash-table :test 'equal))) (dolist (id ids h) (when (stringp id) (setf (gethash id h) t)))))

(defun open-session-view (info scope &key max-chars detail-chars)
  "A view over one of the project's earlier sessions, on its own active branch."
  (let* ((cell (list nil))
         (probe (%make-view :file (session-info-file info) :read-cell cell))
         (branch (second (view-read probe)))
         (effective (cond ((zerop (hash-table-count branch)) "all") ((equal scope "project") "lineage") (t scope))))
    (open-view (session-info-file info) effective branch :session info :max-chars max-chars :detail-chars detail-chars :read-cell cell)))

;;; --- the turn in progress (findCurrentTurn) ----------------------------------------------

(defun current-turn-fn (host-branch lineage)
  "The #N of the turn in progress on the path: its last user message and everything after, when something follows it and no compaction came between."
  (lambda (v)
    (block turn
      (loop for e in (reverse host-branch)
            do (cond ((equal (json-get e "type") "compaction") (return-from turn '()))
                     ((and (equal (json-get e "type") "message") (equal (json-get e "role") "user")) (return))))
      (let* ((on-path (coerce (remove-if-not (lambda (m) (and (second m) (gethash (second m) lineage))) (first (view-read v))) 'vector)))
        (loop for i from (1- (length on-path)) downto 0
              when (equal (json-get (third (aref on-path i)) "role") "user")
                do (return-from turn (if (< i (1- (length on-path))) (map 'list #'first (subseq on-path i)) '())))
        '()))))

;;; --- #N:path --------------------------------------------------------------------------------

(defun file-writes-of (message)
  (loop for c in (tool-calls-of message)
        for w = (file-write-of c)
        when w collect (append w (list :name (call-name c)))))

(defparameter +closing-line-chars+ 160)

(defun file-write-content (tc index full offset limit max-chars via)
  (let* ((body (cond ((getf tc :content))
                     ((getf tc :edits)
                      (join-strings (loop for (old . new) in (getf tc :edits) for i from 1
                                          collect (format nil "--- edit ~d ---~%~a~%--- becomes ---~%~a" i old new))
                                    (format nil "~%~%")))
                     ((getf tc :replace) (format nil "--- old ---~%~a~%--- new ---~%~a" (car (getf tc :replace)) (cdr (getf tc :replace))))
                     (t "(no file content found in tool call arguments)")))
         (path (getf tc :path)) (name (getf tc :name))
         (lines (split-string body #\Newline)) (total (length lines)) (preview 30))
    (cond
      (full
       (let* ((frame (+ (js-length (format nil "File: ~a~%Tool: ~a~%~%" path name)) +closing-line-chars+ (js-length path) (js-length via)))
              (room (max 0 (- max-chars frame))))
         (if (> (js-length body) room)
             (let* ((shown (js-slice body 0 room)) (next (1- (length (split-string shown #\Newline)))))
               (format nil "File: ~a~%Tool: ~a~%~%~a~%~%... (~d more chars than this result has room for. Use #~d:~a:~d~a for the lines from ~d on.)"
                       path name shown (- (js-length body) room) index path next via (1+ next)))
             (format nil "File: ~a~%Tool: ~a~%~%~a" path name body))))
      (offset
       (let* ((start (max 0 offset)) (max-lines (or limit 30)) (end (min (+ start max-lines) total))
              (visible (if (< start end) (subseq lines start end) '())))
         (if (null visible)
             (format nil "Offset ~d is beyond file length ~d. Use #~d:~a~a for the first ~d lines." start total index path via preview)
             (concatenate 'string
                          (format nil "File: ~a~%Tool: ~a~%Lines ~d-~d (of ~d):~%~%" path name (1+ start) end total)
                          (join-strings visible (string #\Newline))
                          (cond ((< end total)
                                 (format nil "~%~%--- Use #~d:~a:~d or #~d:~a:~d:~d for next ~d lines, #~d:~a:full for complete~a ---"
                                         index path end index path end max-lines max-lines index path via))
                                ((> offset 0) (format nil "~%~%(End of file)"))
                                (t ""))))))
      ((> total preview)
       (format nil "File: ~a~%Tool: ~a~%~%~a~%~%...(~d more lines — use #~d:~a:full for complete content, or #~d:~a:~d for next ~d lines~a)"
               path name (join-strings (subseq lines 0 preview) (string #\Newline)) (- total preview) index path index path preview preview via))
      (t (format nil "File: ~a~%Tool: ~a~%~%~a" path name body)))))

(defun expand-entry-file (message index pattern full offset limit max-chars via)
  (if (null message)
      (format nil "Entry #~d not found in session history." index)
      (let ((calls (file-writes-of message)))
        (flet ((listing (cs) (join-strings (mapcar (lambda (tc) (format nil "  [#~d:~a] ~a(~a)" index (getf tc :path) (getf tc :name) (getf tc :path))) cs) (string #\Newline))))
          (if (string= pattern "file")
              (cond ((null calls) (format nil "No file content found in entry #~d." index))
                    ((null (rest calls)) (file-write-content (first calls) index full offset limit max-chars via))
                    (t (format nil "Entry #~d has ~d file operations:~%~a~%~%Use #~d:path~a to drill into a specific file." index (length calls) (listing calls) index via)))
              (let ((matched (remove-if-not (lambda (tc) (search pattern (getf tc :path))) calls)))
                (cond ((null matched) (format nil "No file content found in entry #~d for \"~a\"." index pattern))
                      ((rest matched)
                       (format nil "Entry #~d has ~d file operations matching \"~a\":~%~a~%~%Use #~d:<more-specific-path>~a to drill into a specific file."
                               index (length matched) pattern (listing matched) index via))
                      (t (file-write-content (first matched) index full offset limit max-chars via)))))))))

;;; --- mode:'touched' ----------------------------------------------------------------------------

(defun touched-files (loaded)
  "Every file the entries' writes and edits change, first changed first: (PATH . TOUCHES), a touch (INDEX TOOL DRILLABLE)."
  (let ((by '()))
    (dolist (e loaded)
      (dolist (c (tool-calls-of (getf e :message)))
        (when (member (call-kind c) '(:write :edit))
          (let ((drillable (and (file-write-of c) t)))
            (dolist (path (files-of c))
              (let ((at (assoc path by :test #'string=)))
                (unless at (setf at (list path)) (setf by (append by (list at))))
                (setf (cdr at) (append (cdr at) (list (list (getf e :index) (call-name c) drillable))))))))))
    by))

(defun short-touched-path (path cwd)
  (let ((normalized (substitute #\/ #\\ path)) (dir (substitute #\/ #\\ cwd)))
    (if (starts-with (concatenate 'string dir "/") normalized)
        (concatenate 'string "." (subseq normalized (length dir)))
        (let ((parts (split-string normalized #\/)))
          (if (> (length parts) 3) (format nil ".../~a" (join-strings (last parts 3) "/")) normalized)))))

(defun format-touched (touched page via next cwd)
  (if (null touched)
      "No file operations found in session history."
      (let ((total (ceiling (length touched) +touched-page-size+)))
        (if (> page total)
            (outside-page page total (format nil "~d files touched" (length touched)))
            (let* ((files (subseq touched (* (1- page) +touched-page-size+) (min (length touched) (* page +touched-page-size+))))
                   (header (if (> total 1) (format nil "Page ~d/~d (~d total files)" page total (length touched)) (format nil "~d files touched" (length touched))))
                   (lines (mapcar (lambda (tf) (format nil "  ~a    ~a" (short-touched-path (car tf) cwd)
                                                       (join-strings (mapcar (lambda (e) (format nil "#~d (~a)" (first e) (second e))) (cdr tf)) ", ")))
                                  files))
                   (drill (loop for tf in files
                                for w = (find-if #'third (cdr tf) :from-end t)
                                when w return (cons tf w))))
              (format nil "~a:~%~%~a~a~a" header (join-strings lines (string #\Newline))
                      (if (< page total) (format nil "~%~a" (funcall next (1+ page))) "")
                      (if drill
                          (format nil "~%--- File content at an entry: query:'#~d:~a'~a ---" (first (cdr drill))
                                  (car (last (split-string (substitute #\/ #\\ (car (car drill))) #\/))) via)
                          "")))))))

;;; --- search through a view ------------------------------------------------------------------

(defun search-loaded (loaded query &key (floor +relative-floor+) (cap +result-cap+))
  "Search the entries LOADED for QUERY: (values HITS TOTAL TRUNCATED) with HITS entry plists with :snippet, or (values :aborted MESSAGE)."
  (let ((v (coerce loaded 'vector)))
    (multiple-value-bind (hits total truncated)
        (search-docs query (map 'vector (lambda (e) (list (getf e :role) (search-text (getf e :message)) (getf e :files))) v)
                     :floor floor :cap cap)
      (cond ((eq hits :aborted) (values :aborted total))
            (t (values (mapcar (lambda (h) (append (list :snippet (cdr h)) (aref v (car h)))) hits) total truncated))))))

(defun search-before (v query skip)
  (search-loaded (if skip (remove-if (lambda (e) (member (getf e :index) skip)) (view-load v nil)) (view-load v nil)) query))

(defun other-sessions-note (v hints)
  (if (or (null (getf hints :other-sessions)) (null (view-project v)) (view-session v))
      ""
      (let ((count (funcall (getf (view-project v) :count))))
        (if (> count 0) (format nil "~%~a" (funcall (getf hints :other-sessions) count)) ""))))

(defun page-of-hits (hits total truncated query page &key where scope hints around)
  (let ((pages (ceiling (length hits) +search-page-size+))
        (note (if truncated (format nil " — showing ~d of ~d matches, refine your query for more precise results" (length hits) total) "")))
    (if (and hits (> page pages))
        (format nil "~a ~a" (outside-page page pages (format nil "~d matches~a~a" (length hits) where note))
                (funcall (getf hints :out-of-range) query scope pages truncated))
        (let* ((shown (subseq hits (min (length hits) (* (1- page) +search-page-size+)) (min (length hits) (* page +search-page-size+))))
               (header (if (> pages 1) (format nil "Page ~d/~d (~d total matches~a~a)" page pages (length hits) where note)
                           (format nil "~d matches~a~a" (length hits) where note))))
          (concatenate 'string (format-recall-output shown query header)
                       (if shown (funcall around (first shown)) "")
                       (if (< page pages) (funcall (getf hints :next-page) query scope (1+ page)) ""))))))

(defun run-search (query page v hints skip &optional result)
  (multiple-value-bind (hits total truncated) (if result (values-list result) (search-before v query skip))
    (cond
      ((eq hits :aborted) total)
      (t
       (block search
         (when (and (null hits) (equal (view-scope v) "lineage"))
           (let ((wide (view-widen v)))
             (multiple-value-bind (wh wt wtr) (search-before wide query skip)
               (when (and (not (eq wh :aborted)) wh)
                 (return-from search (concatenate 'string +off-path-note+ (run-search query page wide hints skip (list wh wt wtr))))))))
         (when (and (null hits) skip)
           (let ((in-turn (multiple-value-bind (all) (search-loaded (view-load v nil) query)
                            (if (eq all :aborted) 0 (count-if (lambda (h) (member (getf h :index) skip)) all)))))
             (when (> in-turn 0)
               (return-from search
                 (format nil "No earlier matches for \"~a\"; its ~d match~a in the current turn, which is already in your context.~a"
                         query in-turn (if (= in-turn 1) " is" "es are") (other-sessions-note v hints))))))
         (concatenate 'string
                      (page-of-hits hits total truncated query page
                                    :where (if (equal (view-scope v) "all") " (scope: all)" "") :scope (view-scope v) :hints hints
                                    :around (lambda (top) (let ((f (getf hints :around-hit))) (if f (funcall f (getf top :index) (view-scope v)) ""))))
                      (if (null hits) (other-sessions-note v hints) "")))))))

(defun run-project-search (query page v surface skip)
  (let* ((hints (surface-hints surface nil))
         (corpus (remove-if (lambda (e) (member (getf e :index) skip)) (view-load v nil)))
         (all (funcall (getf (view-project v) :list)))
         (bytes 0) (searched 0))
    (dolist (s (subseq all 0 (min +project-search-sessions+ (length all))))
      (when (and (> (+ bytes (session-info-bytes s)) +project-search-bytes+) (> searched 0)) (return))
      (let ((loaded (view-load (open-session-view s "lineage") nil)))
        (when (and (> (+ (length corpus) (length loaded)) +project-search-entries+) (> searched 0)) (return))
        (setf corpus (append corpus (mapcar (lambda (e) (append (list :session (session-info-short s)) e)) loaded)))
        (incf bytes (session-info-bytes s))
        (incf searched)))
    (let ((covered (if (zerop searched)
                       "this session (no earlier sessions in this project)"
                       (format nil "this session and ~d earlier session~a~a" searched (if (= searched 1) "" "s")
                               (if (< searched (length all)) (format nil " (the newest ~d of ~d; session:'id' reads an older one)" searched (length all)) "")))))
      (multiple-value-bind (hits total truncated) (search-loaded corpus query)
        (cond ((eq hits :aborted) (format nil "~a Searching ~a: narrow the query, or read one session with session:'id' (mode:'sessions' lists them)." total covered))
              ((null hits) (format nil "No matches for \"~a\" in ~a." query covered))
              (t (page-of-hits hits total truncated query page :where (format nil " in ~a" covered) :scope "project" :hints hints
                               :around (lambda (top) (let ((f (getf (surface-hints surface (getf top :session)) :around-hit)))
                                                       (if f (funcall f (getf top :index) "lineage") ""))))))))))

;;; --- the other actions -----------------------------------------------------------------------

(defun run-expand (indices v)
  (let* ((pools (if (equal (view-scope v) "all") (list v) (list v (view-widen v))))
         (found (mapcar (lambda (i) (cons i (and (integerp i)
                                                 (loop for pool in pools
                                                       for loaded = (view-load pool t)
                                                       for pos = (position i loaded :key (lambda (e) (getf e :index)))
                                                       when pos return (list (nth pos loaded) pool pos)))))
                        indices))
         (invalid (loop for (i . hit) in found unless hit collect i)))
    (if invalid
        (format nil "Cannot expand indices outside session history: ~a" (join-strings (mapcar #'js-string-of invalid) ", "))
        (let ((off-path (loop for (i . hit) in found unless (eq (second hit) v) collect (format nil "#~a" i)))
              (out '()))
          (dolist (f found)
            (destructuring-bind (entry pool pos) (cdr f)
              (push entry out)
              (let ((ids (remove-duplicates (remove nil (mapcar #'call-id (tool-calls-of (getf entry :message))))
                                            :test #'string=)))
                (when ids
                  (let ((loaded (view-load pool t)))
                    (loop for r in (nthcdr (1+ pos) loaded)
                          while ids
                          do (let ((m (getf r :message)))
                               (when (equal (json-get m "role") "assistant") (return))
                               (when (and (equal (json-get m "role") "toolResult") (member (json-get m "toolCallId") ids :test #'equal))
                                 (setf ids (remove (json-get m "toolCallId") ids :test #'equal))
                                 (unless (member (getf r :index) indices)
                                   (let* ((clip (view-detail-chars pool)) (summary (getf r :summary)))
                                     (push (append (list :summary (if (> (js-length summary) clip)
                                                                      (format nil "~a~%...[result of #~d clipped at ~d of ~d chars; expand:[~d]~a for all of it]"
                                                                              (js-slice summary 0 clip) (getf entry :index) clip (js-length summary) (getf r :index) (via pool))
                                                                      summary))
                                                   r)
                                           out)))))))))))
          (concatenate 'string (if (equal (view-scope v) "all") (format nil "Scope: all~%~%") "")
                       (if off-path (format nil "~a ~a not on the current conversation path (edited or retried branch).~%~%"
                                            (join-strings off-path ", ") (if (= (length off-path) 1) "is" "are"))
                           "")
                       (format-recall-output (nreverse out) nil (format nil "Expanded ~a" (join-strings (mapcar (lambda (i) (format nil "#~a" i)) indices) ", "))))))))

(defun run-range (range page v)
  (destructuring-bind (lo to) range
    (let* ((hi to) (all (equal (view-scope v) "all"))
           (rendered (view-load v nil))
           (entries (remove-if-not (lambda (e) (<= lo (getf e :index) hi)) rendered)))
      (if (null entries)
          (or (and (not all)
                   (let ((wide (view-widen v)))
                     (and (some (lambda (e) (<= lo (getf e :index) hi)) (view-load wide nil))
                          (concatenate 'string +off-path-note+ (run-range range page wide)))))
              (format nil "No messages #~d..#~d in session history~a." lo hi
                      (if rendered (format nil " (last entry is #~d)" (getf (car (last rendered)) :index)) "")))
          (let* ((last-index (getf (car (last rendered)) :index))
                 (clamped (> hi last-index)))
            (when clamped (setf hi last-index))
            (let* ((pages (ceiling (length entries) +range-page-size+))
                   (counts (format nil "~d messages~a~a" (length entries) (if all ", scope: all" "") (if clamped (format nil ", #~d is the last entry" hi) ""))))
              (if (> page pages)
                  (format nil "~a Use a page between 1 and ~d." (outside-page page pages (format nil "#~d..#~d: ~a" lo hi counts)) pages)
                  (concatenate 'string
                               (format-recall-output (subseq entries (* (1- page) +range-page-size+) (min (length entries) (* page +range-page-size+))) nil
                                                     (if (> pages 1) (format nil "Range #~d..#~d, page ~d/~d (~a)" lo hi page pages counts) (format nil "Range #~d..#~d (~a)" lo hi counts)))
                               (if (< page pages)
                                   (format nil "~%--- Use range:[~d, ~d] page:~d~a for the next ~d ---" lo hi (1+ page)
                                           (with-params (session-param (and (view-session v) (session-info-short (view-session v)))) (scope-param (view-scope v)))
                                           +range-page-size+)
                                   "")))))))))

(defun run-sessions (page v hints)
  (multiple-value-bind (sessions more) (funcall (getf (view-project v) :list))
    (if (null sessions)
        "No earlier sessions in this project (the session directory has no other session files)."
        (let ((pages (ceiling (length sessions) +sessions-page-size+)))
          (if (> page pages)
              (outside-page page pages (format nil "~d earlier sessions" (length sessions)))
              (let* ((start (* (1- page) +sessions-page-size+))
                     (lines (mapcar (lambda (s) (format nil "~a~a" (describe-session s)
                                                        (if (session-info-pins s) (format nil "~%  pinned: ~a" (join-strings (session-info-pins s) "; ")) "")))
                                    (subseq sessions start (min (length sessions) (+ start +sessions-page-size+)))))
                     (more-note (if more (format nil ", the newest ~d (session:'id' reads an older one)" +max-listed-sessions+) ""))
                     (header (if (> pages 1)
                                 (format nil "Earlier sessions in this project, newest first, page ~d/~d (~d sessions~a):" page pages (length sessions) more-note)
                                 (format nil "~d earlier session~a in this project, newest first~a:" (length sessions) (if (= (length sessions) 1) "" "s") more-note))))
                (format nil "~a~%~%~a~%~%--- Read one: session:'~a' with a query, range, expand or mode:'touched'; search all: a query with scope:'project' ---~a"
                        header (join-strings lines (string #\Newline)) (session-info-short (nth start sessions))
                        (if (< page pages) (funcall (getf hints :list-page) "sessions" (1+ page) (view-scope v)) ""))))))))

(defun run-action (request v surface skip-turn cwd)
  (let* ((action (getf request :action))
         (hints (surface-hints surface (and (view-session v) (session-info-short (view-session v)))))
         (all (equal (view-scope v) "all")))
    (ecase (first action)
      (:drill (destructuring-bind (index path full offset limit) (rest action)
                (note-shown (list index))
                (let* ((message (view-message v index))
                       (off (and message (not all) (notany (lambda (e) (eql (getf e :index) index)) (view-load v nil)))))
                  (concatenate 'string (if off +off-path-note+ "")
                               (expand-entry-file message index path full offset limit
                                                  (- (view-max-chars v) (if off (js-length +off-path-note+) 0)) (via v))))))
      (:touched (format-touched (touched-files (view-load v nil)) (second action) (via v)
                                (lambda (n) (funcall (getf hints :list-page) "touched" n (view-scope v))) cwd))
      (:sessions (run-sessions (second action) v hints))
      (:expand (run-expand (second action) v))
      (:range (run-range (second action) (third action) v))
      (:search (let ((skip (and skip-turn (view-current-turn v))))
                 (if (equal (view-scope v) "project")
                     (run-project-search (second action) (third action) v surface skip)
                     (run-search (second action) (third action) v hints skip))))
      (:recent (concatenate 'string (if all (format nil "Scope: all~%~%") "")
                            (format-recall-output (last-n (view-load v nil) +recent-count+)))))))

(defun run-recall (input)
  "One recall: (values OK TEXT SEVERITY SHOWN). INPUT carries the call (the tool's
params or the command's text) and the host's part. SHOWN is the #N of this
session's entries it showed (another session's #N are its own, so a call with
session:'id' shows none)."
  (let* ((call (json-get input "call"))
         (surface (if (equal (json-get call "surface") "command") (list :command (json-get call "name")) (list :tool)))
         (request (if (eq (first surface) :tool) (parse-tool-request (json-get call "params")) (parse-command-request (string-or (json-get call "args") ""))))
         (file (json-get input "sessionFile"))
         (files (strings-of (json-get input "projectFiles")))
         (cwd (string-or (json-get input "cwd") ""))
         (lineage (ids-set (strings-of (json-get input "lineageIds"))))
         (host-branch (coerce (json-get input "hostBranch" #()) 'list)))
    (if (not (and (stringp file) (plusp (length file))))
        (values nil "No session file available." "error")
        (let* ((listed nil)
               (project (list :list (lambda () (unless listed (setf listed (multiple-value-list (list-project-sessions files)))) (values-list listed))
                              :count (lambda () (length (project-ids files)))))
               (max (recall-output-chars (json-get input "contextWindow")))
               (note (ignored-note request))
               (detail (expand-detail-chars max))
               (skip-turn (eq (json-get input "skipCurrentTurn") :true)))
          (if (getf request :session)
              (let ((target (find-session files (getf request :session))))
                (if (and (consp target) (eq (first target) :error))
                    (values nil (second target) "warning")
                    (let* ((header (format nil "Session ~a~%~%" (describe-session target)))
                           (v (open-session-view target (getf request :scope) :max-chars (- max (js-length header) (js-length note)) :detail-chars detail)))
                      (values t (concatenate 'string header (cap-output (concatenate 'string note (let ((*entry-notes* (superseded-notes v))) (run-action request v surface skip-turn cwd))) (max 0 (- max (js-length header)))))))))
              (let ((v (open-view file (getf request :scope) lineage :project project :max-chars (- max (js-length note)) :detail-chars detail
                                  :turn-fn (current-turn-fn host-branch lineage)))
                    (*shown-entries* '()))
                (let ((text (cap-output (concatenate 'string note (let ((*entry-notes* (superseded-notes v))) (run-action request v surface skip-turn cwd))) max)))
                  (values t text nil (shown-entries)))))))))
