;;;; request.lisp --- a recall call as one request, and how its output is worded.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The tool's params, repaired where their meaning is certain, and the
;;;; command's text, read into one request, with the Ignored: note; #N:path
;;;; parsed; and the wording of recall's output. Agents act on this text: it is
;;;; an interface.
;;;;
;;;; A request is a plist: :scope, :action (a list headed by its kind),
;;;; :session, :ignored ((PARAM . WHY) ...), :dropped (strings).

(in-package #:omp-vcc)

(defparameter +scopes+ '("lineage" "all" "project"))
(defparameter +modes+ '("hybrid" "touched" "sessions"))

;;; --- #N:path ------------------------------------------------------------------

(defun parse-drill-down (query)
  "QUERY as #N:path: (:drill INDEX PATH FULL OFFSET LIMIT), or NIL."
  (let ((m (rx-exec (rx "^#(\\d+):(.+?)(?::(full|\\d+(?::\\d+)?))?$") query)))
    (when m
      (let ((index (parse-integer (rx-group m 1))) (path (rx-group m 2)) (suffix (rx-group m 3)))
        (cond ((equal suffix "full") (list :drill index path t nil nil))
              (suffix (let ((parts (split-string suffix #\:)))
                        (list :drill index path nil (parse-integer (first parts))
                              (and (second parts) (parse-integer (second parts))))))
              (t (list :drill index path nil nil nil)))))))

;;; --- the tool's params (normalizeToolParams) --------------------------------------

(defun to-index (v)
  "12, \"12\", \"#12\", \" 12 \" -> 12; anything else NIL."
  (cond ((integerp v) (and (>= v 0) v))
        ((floatp v) (and (= v (ftruncate v)) (>= v 0) (truncate v)))
        ((stringp v) (let ((m (rx-exec (rx "^#?(\\d+)$") (js-trim v)))) (and m (parse-integer (rx-group m 1)))))))

(defun index-list (s)
  "\"12\", \"#12, #15\", \"12 15\" -> numbers; NIL unless the whole string is #N tokens."
  (let ((tx (rx-replace (rx "^\\[|\\]$") (js-trim s) "" :all t)))
    (when (rx-test (rx "^\\s*#?\\d+(\\s*[,\\s]\\s*#?\\d+)*\\s*$") tx)
      (mapcar (lambda (m) (parse-integer (rx-group m))) (rx-all (rx "\\d+") tx)))))

(defun session-ref (ref)
  "\"@01a1\", \"session:01a1\", \"'01a1'\" -> \"01a1\"."
  (let ((s (rx-replace (rx "^(?:@|session:)" "i") (js-trim ref) "")))
    (let ((m (rx-exec (rx "^(['\"])(.*)\\1$") s))) (if m (rx-group m 2) s))))

(defun normalize-tool-params (raw)
  "The params as plist (:query :expand :range :page :scope :mode :session), and what was dropped."
  (if (not (json-object-p raw))
      (values '() '())
      (let ((p (copy-object raw)) (dropped '()))
        (flet ((drop (key why)
                 (push (format nil "~a ~a (~a)" key (json-string (gethash key p)) why) dropped)
                 (remhash key p)))
          (dolist (key (json-keys p)) (when (unset-p (gethash key p)) (remhash key p)))
          (dolist (key (json-keys p)) (unless (member key +recall-params+ :test #'string=) (drop key "not a vcc_recall param")))
          (multiple-value-bind (v present) (gethash "page" p)
            (when present (let ((n (to-index v))) (if (and n (>= n 1)) (setf (gethash "page" p) n) (drop "page" "not a page number")))))
          (multiple-value-bind (v present) (gethash "expand" p)
            (when present
              (let ((list (cond ((json-array-p v) (map 'list #'to-index v))
                                ((stringp v) (index-list v))
                                (t (list (to-index v))))))
                (if (and (or list (json-array-p v)) (every #'identity list))
                    (setf (gethash "expand" p) list)
                    (drop "expand" "not #N indices")))))
          (multiple-value-bind (v present) (gethash "range" p)
            (when present
              (let ((pair (cond ((json-array-p v) (map 'list #'to-index v))
                                ((stringp v)
                                 (let ((m (rx-exec (rx "^\\[?\\s*#?(\\d+)\\s*(?:(?:-|\\.\\.|,|to)\\s*#?(\\d+)\\s*)?\\]?$" "i") (js-trim v))))
                                   (and m (list (parse-integer (rx-group m 1)) (parse-integer (or (rx-group m 2) (rx-group m 1)))))))
                                (t (list (to-index v))))))
                (when (= (length pair) 1) (setf pair (list (first pair) (first pair))))
                (if (and pair (= (length pair) 2) (every #'identity pair))
                    (setf (gethash "range" p) (if (<= (first pair) (second pair)) pair (reverse pair)))
                    (drop "range" "not [from, to]")))))
          (dolist (key '("scope" "mode"))
            (when (stringp (gethash key p)) (setf (gethash key p) (string-downcase (js-trim (gethash key p))))))
          (when (and (not (nth-value 1 (gethash "scope" p))) (member (gethash "mode" p) +scopes+ :test #'equal))
            (setf (gethash "scope" p) (gethash "mode" p))
            (remhash "mode" p))
          (when (and (nth-value 1 (gethash "scope" p)) (not (member (gethash "scope" p) +scopes+ :test #'equal)))
            (drop "scope" "use 'lineage', 'all' or 'project'"))
          (when (and (nth-value 1 (gethash "mode" p)) (not (member (gethash "mode" p) +modes+ :test #'equal)))
            (drop "mode" "use 'touched', 'sessions' or leave it out"))
          (multiple-value-bind (v present) (gethash "session" p)
            (when present
              (if (and (stringp v) (plusp (length (session-ref v))))
                  (setf (gethash "session" p) (session-ref v))
                  (drop "session" "not a session id"))))
          (multiple-value-bind (v present) (gethash "query" p)
            (when (and present (not (stringp v))) (drop "query" "not text"))))
        (values (list :query (gethash "query" p) :expand (gethash "expand" p) :range (gethash "range" p)
                      :page (gethash "page" p) :scope (gethash "scope" p) :mode (gethash "mode" p) :session (gethash "session" p))
                (nreverse dropped)))))

;;; --- the request (requestOf) ----------------------------------------------------------

(defparameter +alone+
  '((:drill . "a #N:path query runs alone")
    (:touched . "mode:'touched' runs alone")
    (:sessions . "mode:'sessions' runs alone")
    (:expand . "expand runs alone; send the rest in a separate call")
    (:range . "range runs alone; send the rest in a separate call")
    (:recent . "page applies to a query, a range, touched or sessions")))

(defun request-of (&key query expand range page scope mode session dropped)
  "The request from what a call names; the precedence lives here only."
  (let* ((query (and (stringp query) (plusp (length (js-trim query))) query))
         (expand (remove-duplicates expand :from-end t))
         (page (max 1 (or page 1)))
         (drill (and query (parse-drill-down (js-trim query))))
         (action (cond (drill drill)
                       ((equal mode "touched") (list :touched page))
                       ((equal mode "sessions") (list :sessions page))
                       (expand (list :expand expand))
                       (range (list :range range page))
                       (query (list :search query page))
                       (t (list :recent))))
         (kind (first action))
         (paged (member kind '(:touched :sessions :range :search)))
         (why (if (eq kind :search) "" (cdr (assoc kind +alone+))))
         (ignored (loop for (param set) in (list (list "query" (and query (not (member kind '(:drill :search)))))
                                                 (list "expand" (and expand (not (eq kind :expand))))
                                                 (list "range" (and range (not (eq kind :range))))
                                                 (list "page" (and (> page 1) (not paged)))
                                                 (list "mode" (and mode (not (equal mode "hybrid")) (not (member kind '(:touched :sessions))))))
                        when set collect (cons param why)))
         (scope (or scope "lineage")))
    (cond ((and session (eq kind :sessions))
           (setf ignored (append ignored (list (cons "session" "mode:'sessions' lists the sessions, it does not read one"))) session nil))
          ((and session (equal scope "project"))
           (setf ignored (append ignored (list (cons "scope" "scope:'project' searches from this session; one earlier session has no earlier ones of its own")))
                 scope "lineage")))
    (list :scope scope :action action :session session :ignored ignored :dropped dropped)))

(defun parse-tool-request (raw)
  (multiple-value-bind (params dropped) (normalize-tool-params raw)
    (let ((range (getf params :range)))
      (request-of :query (getf params :query) :expand (getf params :expand)
                  :range (and (= (length range) 2) range) :page (getf params :page)
                  :scope (getf params :scope) :mode (getf params :mode) :session (getf params :session) :dropped dropped))))

(defun parse-command-request (args)
  "/omp-vcc-recall's text: a query, scope:all|project, session:<id> and page:N; \"sessions\" alone lists them."
  (let ((text (js-trim args)))
    (flet ((take (regex)
             (let ((m (rx-exec regex text)))
               (when m
                 (setf text (js-trim (collapse-whitespace (rx-replace regex text " "))))
                 (rx-group m 1)))))
      (let* ((scope (let ((s (take (rx "\\bscope:['\"]?(lineage|all|project)\\b['\"]?" "i")))) (and s (string-downcase s))))
             (session (take (rx "(?:^|\\s)session:(\\S+)" "i")))
             (page (take (rx "\\bpage:['\"]?(\\d+)\\b['\"]?" "i")))
             (sessions (and (null session) (rx-test (rx "^sessions$" "i") text))))
        (request-of :query (if sessions nil text) :mode (and sessions "sessions")
                    :page (and page (parse-integer page)) :scope scope :session (and session (session-ref session)))))))

(defun ignored-note (request)
  "One line per reason naming the params the action did not use."
  (let* ((dropped (getf request :dropped))
         (head (if dropped (format nil "Ignored: ~a.~%" (join-strings dropped ", ")) ""))
         (reasons '()))
    (dolist (i (getf request :ignored))
      (let ((at (assoc (cdr i) reasons :test #'string=)))
        (if at (setf (cdr at) (append (cdr at) (list (car i)))) (setf reasons (append reasons (list (list (cdr i) (car i))))))))
    (let ((body (join-strings (mapcar (lambda (r) (format nil "Ignored: ~a~:[~; (~a)~].~%" (join-strings (cdr r) ", ") (plusp (length (car r))) (car r))) reasons) "")))
      (if (or (plusp (length head)) (plusp (length body))) (format nil "~a~a~%" head body) ""))))

;;; --- wording ---------------------------------------------------------------------------------

(defun with-params (&rest params)
  (let ((set (remove nil params))) (if set (format nil " with ~a" (join-strings set " and ")) "")))
(defun session-param (short) (and short (format nil "session:'~a'" short)))
(defun scope-param (scope) (if (equal scope "lineage") nil (format nil "scope:'~a'" scope)))
(defun outside-page (page total what) (format nil "Page ~d is outside the available range 1-~d (~a)." page total what))

(defun format-recall-output (entries &optional query header)
  "ENTRIES (plists :index :role :summary :files :session :snippet) under a header."
  (if (null entries)
      (if query (format nil "No matches for \"~a\" in session history." query) "No entries in session history.")
      (format nil "~a~%~%~a"
              (if header (format nil "~a~@[ for \"~a\"~]:" header query) (format nil "Session history (~d entries):" (length entries)))
              (join-strings (mapcar (lambda (e)
                                      (format nil "~@[[session ~a] ~]#~a [~a]~a ~a"
                                              (getf e :session) (getf e :index) (getf e :role)
                                              (if (getf e :files) (format nil " files:[~a]" (join-strings (getf e :files) ", ")) "")
                                              (if (and query (getf e :snippet)) (getf e :snippet) (getf e :summary))))
                                    entries)
                            (format nil "~%~%")))))

;;; --- the two surfaces' hints ------------------------------------------------------------------

(defun scope-arg (scope) (cond ((equal scope "all") " scope:all") ((equal scope "project") " scope:project") (t "")))

(defun surface-hints (surface short)
  "The follow-up hints of SURFACE ((:tool) or (:command NAME)), in the session SHORT names:
a plist of functions :out-of-range :next-page :list-page :around-hit :other-sessions (the last two NIL where the surface has none)."
  (let ((plural (lambda (n one many) (if (= n 1) one many))))
    (if (eq (first surface) :tool)
        (let ((session (session-param short)))
          (flet ((call (param scope) (join-strings (remove nil (list session param (scope-param scope))) ", ")))
            (list :out-of-range (lambda (query scope total truncated) (declare (ignore query scope))
                                  (if truncated (format nil "Use a page between 1 and ~d." total)
                                      (format nil "Use a page between 1 and ~d, or refine your query." total)))
                  :next-page (lambda (query scope page) (declare (ignore query))
                               (format nil "~%--- Use page:~d~a for more results ---" page (with-params session (scope-param scope))))
                  :list-page (lambda (mode page scope)
                               (format nil "~%--- Use mode:'~a' page:~d~a for more results ---" mode page (with-params session (scope-param scope))))
                  :around-hit (lambda (n scope)
                                (format nil "~%--- Read around a hit: ~a; full text: ~a ---"
                                        (call (format nil "range:[~d, ~d]" (max 0 (- n 3)) (+ n 3)) scope)
                                        (call (format nil "expand:[~d]" n) scope)))
                  :other-sessions (lambda (n)
                                    (format nil "This project has ~d earlier session~a: scope:'project' searches ~a too; mode:'sessions' lists ~a."
                                            n (funcall plural n "" "s") (funcall plural n "it" "them") (funcall plural n "it" "them"))))))
        (let ((name (second surface)) (at (if short (format nil " session:~a" short) "")))
          (list :out-of-range (lambda (query scope total truncated)
                                (format nil "Use /~a ~a~a~a page:N with N between 1 and ~d~a" name query at (scope-arg scope) total
                                        (if truncated "." ", or refine your query.")))
                :next-page (lambda (query scope page) (format nil "~%--- /~a ~a~a~a page:~d ---" name query at (scope-arg scope) page))
                :list-page (lambda (mode page scope) (declare (ignore scope))
                             (if (equal mode "sessions") (format nil "~%--- /~a sessions page:~d ---" name page) ""))
                :around-hit nil
                :other-sessions (lambda (n)
                                  (format nil "This project has ~d earlier session~a: add scope:project to search ~a too; /~a sessions lists ~a."
                                          n (funcall plural n "" "s") (funcall plural n "it" "them") name (funcall plural n "it" "them"))))))))
