;;;; surface.lisp --- what keel shows a host, and what the host does on its answers.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The tools and commands keel registers are defined here, words and schemas
;;;; alike: op surface hands them over, and src/surface.ts is that answer
;;;; written down (scripts/surface.ts; tests/surface.test.ts holds it to this),
;;;; since a host registers them at load, before a core may be built.
;;;;
;;;; A call through one of them comes back as text for the host and EFFECTS,
;;;; the host calls the binding makes on keel's behalf, in order:
;;;;
;;;;   {"do":"append","customType":T,"data":D}    pi.appendEntry(T, D)
;;;;   {"do":"tell","text":T,"severity":S}        the user is told T
;;;;   {"do":"send","what":W,"message":M,"options":O}
;;;;                                              pi.sendMessage(M, O); W names it if the host refuses it
;;;;
;;;; so the TypeScript side (src/register.ts) has one way to act and decides
;;;; nothing.

(in-package #:keel)

;;; --- the tools ---------------------------------------------------------------------

(defparameter +refs-schema+
  '(:any-of ((:array (:any-of (:number :string))) :number :string))
  "#N refs or ranges: a list of numbers or strings, or one of either.")
(defparameter +indices-schema+
  '(:any-of ((:array (:any-of (:number :string))) :string :number))
  "recall's range and expand: the same forms, in the order the tool has always listed them.")

(defun schema (spec)
  "SPEC, a short form of a JSON Schema, as the JSON object: :string, :number,
:boolean, (:array ITEM), (:any-of (SPEC...))."
  (cond ((keywordp spec) (json-object "type" (string-downcase (symbol-name spec))))
        ((eq (first spec) :array) (json-object "type" "array" "items" (schema (second spec))))
        ((eq (first spec) :any-of) (json-object "anyOf" (map 'vector #'schema (second spec))))))

(defun params-schema (params)
  "The tool's parameters: PARAMS is (NAME SPEC DESCRIPTION [:described-first]) each,
in order; the schema's keys keep the order the tools have always sent, since a
tool's definition is part of the prompt the provider caches."
  (let ((properties (make-hash-table :test 'equal)))
    (loop for (name spec description first) in params
          do (setf (gethash name properties)
                   (if first
                       (let ((s (json-object "description" description)))
                         (maphash (lambda (k v) (setf (gethash k s) v)) (schema spec))
                         s)
                       (let ((s (schema spec))) (setf (gethash "description" s) description) s))))
    (json-object "type" "object" "properties" properties)))

(defun recall-tool ()
  (json-object
   "name" +recall-tool+ "label" "Keel Recall"
   "description"
   (lines "Recall earlier parts of this session, including anything dropped by compaction."
          "Use it before saying the context is gone."
          ""
          "Pick one per call:"
          (format nil "- query: keyword search (regex works), ~d results per page." +search-page-size+)
          (format nil "- range: [from, to]: entries #from..#to in order, ~d per page." +range-page-size+)
          "- expand: [N, ...]: full text of those entries."
          "- mode: 'touched': files worked on, with entry indices."
          "- mode: 'sessions': this project's earlier sessions (restarts, /new, forks, handoffs)."
          "- query '#N:path': file content from entry N ('#N:path:full' for all lines)."
          ""
          "Add to any of them:"
          "- page: next page of query, range, touched or sessions results."
          "- scope: 'lineage' (default) reads the current conversation path; 'all' also"
          "  reads edited or retried branches; 'project' makes a query search this"
          "  project's earlier sessions too."
          "- session: an earlier session's id (from mode:'sessions' or a [session id] hit):"
          "  the call reads that session; its #N are its own."
          ""
          "#N is the number shown in summary refs like (#12) and in recall results."
          (format nil "One result is capped at ~d KB (less on a small context window)." (round +recall-output-chars+ 1024)))
   "parameters"
   (params-schema
    `(("query" :string "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. '#N:path' instead shows a file's content from entry N.")
      ("range" ,+indices-schema+ ,(format nil "[from, to]: every entry from #from to #to (inclusive) in order, ~d per page. #N is the number in summary refs like (#12) and in recall results." +range-page-size+))
      ("expand" ,+indices-schema+ "#N indices to return full content for (from summary refs like (#12) or recall results).")
      ("page" (:any-of (:number :string)) "Page number (1-based) for query, range, touched or sessions results. Default: 1.")
      ("scope" :string "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried. 'project' makes a query also search this project's earlier sessions.")
      ("mode" :string "hybrid (default) = normal recall; touched = files worked on, by path, with entry indices (misses files written by shell commands); sessions = this project's earlier sessions, newest first.")
      ("session" :string ,(format nil "Id (or its first ~d+ characters) of an earlier session from mode:'sessions' or a [session id] hit: the call reads that session instead of this one." +session-ref-min-chars+))))))

(defun pin-tool ()
  (json-object
   "name" +pin-tool+ "label" "Keel Pin"
   "description"
   (lines "Pin a short note that must survive every compaction: a decision and its reason, a constraint, a fact"
          "the rest of the task depends on. Pinned notes are kept verbatim at the top of every summary until"
          "unpinned; everything else in a summary ages out on a long task."
          ""
          (format nil "- note: the text to pin, one self-contained line (clipped at ~d chars)." +pin-chars+)
          "- name: optional, with note: a short name for it (e.g. auth-plan). Pinning a name again replaces"
          "  its note, so keep a plan, a decision or a command current under one name instead of adding notes."
          "- unpin: the [N] or the name of a note that no longer holds."
          "- neither: list the pinned notes."
          ""
          (format nil "Pin sparingly, what you would need if you lost the conversation; the user pins with /~a-pin." +command+))
   "parameters"
   (params-schema
    `(("note" :string "Text to pin: one self-contained line, e.g. 'Sessions live in SQLite, not Redis: the deploy host has no Redis.'")
      ("name" :string ,(format nil "A name for the note (letters, digits, . _ -, up to ~d chars), e.g. 'auth-plan'. A note pinned under a name already pinned replaces it." +pin-name-chars+))
      ;; unpin also takes "#3": omp has no prepareArguments, so the schema takes either and pins.lisp reads both.
      ("unpin" (:any-of (:number :string)) "The [N] or the name of a pinned note to remove." :described-first)))))

(defun context-tool ()
  (json-object
   "name" +context-tool+ "label" "Keel Context"
   ;; Registered only with the evict setting on.
   "when" "evict"
   "description"
   (lines "Decide what stays in your context. Old turns can leave it whole: nothing is summarized or rewritten,"
          (format nil "the session keeps every word, and ~a expand:[N] reads any entry back exactly. A turn starts at" +recall-tool+)
          "a user request and holds every call and result after it; the turn running now always stays. Each"
          "request in your context starts with its turn's #N, as [#12], so you can drop by it without listing first."
          "Your context is also mirrored in a file (its path is the first line of your context): edit it with your"
          "tools, deleting a turn's block, rewriting its text as what to keep, or writing notes between blocks, and the"
          "next request sends what it says. This tool is the short way to the same edits."
          ""
          "- no params: list the turns in context, by #N range and size, and what is out."
          "- drop: #N refs or ranges ('#12-#40'); every turn they touch leaves from the next request."
          "- oldest: how many of the oldest turns in context leave."
          "- restore: #N refs or ranges of turns to bring back."
          "- note: with drop or oldest, one line kept where the turns were (what they settled, what to look up)."
          "- undo: true reverses the last edit (what it took out comes back, or what it brought back leaves)."
          ""
          "Drop rarely and in large runs from the oldest end: each edit makes the provider read again all that"
          "follows it, so a drop that frees too little for that is held back, with the run that would pay (force: true"
          "takes it out anyway: when the user asked for it, or what it holds is done with);"
          (format nil "past ~d% of where the host compacts, the oldest turns leave by themselves; the user evicts with /~a-evict."
                  +evict-at-percent+ +command+))
   "parameters"
   (params-schema
    `(("drop" ,+refs-schema+ "#N refs or ranges of turns to take out, e.g. ['#12-#40'] or [12]." :described-first)
      ("oldest" :number "How many of the oldest turns in context to take out.")
      ("restore" ,+refs-schema+ "#N refs or ranges of turns to bring back into context." :described-first)
      ("note" :string ,(format nil "One line kept in place of the turns taken out (clipped at ~d chars)." +context-note-chars+))
      ("undo" :boolean "true: reverse the last edit of the context.")
      ("force" :boolean "true, with drop or oldest: take them out even where it does not pay back what the provider reads again.")))))

;;; --- the commands ------------------------------------------------------------------

(defparameter +commands+
  '(("" "Compact the conversation into a keel structured summary (keep:N keeps the last N user turns)")
    ("recall" "Recall earlier parts of this session. Plain keywords work best; scope:all reaches edited or retried turns, scope:project this project's earlier sessions; 'sessions' lists them, session:<id> reads one.")
    ("pin" "Pin a note that stays at the top of every keel summary; name:NAME first names it, and a name pinned again is replaced. No text lists the pinned notes.")
    ("unpin" "Unpin a keel note by its [N] or its name.")
    ("evict" "Take old turns out of the context whole (no text: the oldest half; N, all, #A-#B, restore #A-#B, list)."))
  "Each command's suffix after /keel and its description. /keel itself starts a compaction, which the binding runs (src/compaction.ts).")

(defun surface-json ()
  "Everything a binding registers, and the entry types whose data its snapshots carry."
  (json-object
   "command" +command+
   "tools" (vector (recall-tool) (pin-tool) (context-tool))
   "commands" (map 'vector (lambda (c) (json-object "suffix" (first c) "description" (second c))) +commands+)
   "dataEntryTypes" (vector +pin-entry-type+ +legacy-pin-entry-type+ +evict-entry-type+ +legacy-evict-entry-type+ +recall-entry-type+)
   ;; With eviction off, a request is left as it is unless one of these is on its branch.
   "evictEntryTypes" (vector +evict-entry-type+ +legacy-evict-entry-type+)))

;;; --- effects -----------------------------------------------------------------------

(defun append-effect (type data) (json-object "do" "append" "customType" type "data" data))
(defun tell-effect (text &optional (severity "info")) (json-object "do" "tell" "text" text "severity" severity))
(defun send-effect (what type content options)
  (json-object "do" "send" "what" what "message" (json-object "customType" type "content" content "display" :true) "options" options))

(defun appends (type ops) (map 'list (lambda (op) (append-effect type op)) ops))

(defun call-answer (text effects)
  "What a call through the surface comes back as."
  (json-object "ok" :true "text" (or text :null) "effects" (coerce (remove nil effects) 'vector)))

;;; --- calls through it --------------------------------------------------------------

(defun pin-call (request call)
  "One pin call (pins.lisp run-pin) in REQUEST's snapshot: (values DONE TEXT OP SEVERITY AGENT-NOTE)."
  (run-pin (pin-input (read-snapshot (json-get request "host")) call)))

(defun recall-call (request call)
  "One recall call (recall.lisp run-recall) in REQUEST's snapshot: (values OK TEXT SEVERITY SHOWN AT),
SHOWN what it showed of this session and AT the #N count then (feedback.lisp)."
  (let ((s (read-snapshot (json-get request "host"))))
    (multiple-value-bind (ok text severity shown) (run-recall (recall-input s call (json-get request "projectFiles" #())))
      (values ok text severity shown (snapshot-count s)))))

(defun handle-tool (request)
  "One call of a keel tool: its text for the agent, and the entries it records."
  (let* ((name (json-get request "name"))
         (call (json-object "surface" "tool" "params" (json-get request "params" :null))))
    (cond ((equal name +recall-tool+)
           ;; What the agent recalled is kept as a signal of what it needs (feedback.lisp).
           (multiple-value-bind (ok text severity shown at) (recall-call request call)
             (declare (ignore ok severity))
             (call-answer text (and shown (list (append-effect +recall-entry-type+ (recall-op shown at)))))))
          ((equal name +pin-tool+)
           (multiple-value-bind (done text op) (pin-call request call)
             (declare (ignore done))
             (call-answer text (and (truthy-p op) (list (append-effect +pin-entry-type+ op))))))
          ((equal name +context-tool+)
           (let ((reply (evict-for-host (read-snapshot (json-get request "host")) call)))
             (call-answer (json-get reply "text") (appends +evict-entry-type+ (json-get reply "ops")))))
          (t (json-object "ok" :false "error" (format nil "tool: no tool ~a" name))))))

(defun handle-command (request)
  "One of keel's commands typed by the user (all but /keel): what the user is told and the agent sent."
  (let* ((suffix (json-get request "suffix")) (args (or (json-get request "args") "")))
    (cond ((equal suffix "recall")
           (multiple-value-bind (ok text severity) (recall-call request (json-object "surface" "command" "name" suffix "args" args))
             (call-answer nil (list (if ok
                                        (send-effect "the recall result" +recall-command-message-type+ text (json-object "triggerTurn" :true))
                                        (tell-effect text severity))))))
          ((member suffix '("pin" "unpin") :test #'equal)
           (multiple-value-bind (done text op severity note) (pin-call request (json-object "surface" "command" "name" suffix "args" args))
             (declare (ignore done))
             (call-answer nil (list (and (truthy-p op) (append-effect +pin-entry-type+ op))
                                    (tell-effect text (or severity "info"))
                                    ;; The agent hears it on its next request, without a turn of its own.
                                    (and (stringp note)
                                         (send-effect "the pin to the agent" +pin-notice-type+ note (json-object "deliverAs" "nextTurn")))))))
          ((equal suffix "evict")
           (let ((reply (evict-for-host (read-snapshot (json-get request "host")) (json-object "surface" "command" "args" args))))
             (call-answer nil (append (appends +evict-entry-type+ (json-get reply "ops")) (list (tell-effect (json-get reply "text")))))))
          (t (json-object "ok" :false "error" (format nil "command: no command ~a" suffix))))))

(defun handle-session-start (request)
  "A session starting: the named notes of the project's last session carried into
it (pins.lisp), and where that session stopped told to the agent with the first
prompt (resume.lisp)."
  (let ((files (json-get request "projectFiles" #())))
    (if (zerop (length files))
        (call-answer nil nil)
        (multiple-value-bind (done text ops) (pin-call request (json-object "surface" "carry" "files" files))
          (declare (ignore done))
          ;; Read before the pins land: a session with nothing in it yet.
          (let ((briefing (resume-briefing (coerce (snapshot-tree (read-snapshot (json-get request "host"))) 'list)
                                           (coerce files 'list))))
            (call-answer nil (append (and (plusp (length (or ops #())))
                                          (append (appends +pin-entry-type+ ops) (list (tell-effect (format nil "keel: ~a" text)))))
                                     (and briefing
                                          (list (send-effect "where the last session stopped" +resume-notice-type+ briefing
                                                             (json-object "deliverAs" "nextTurn")))))))))))

(defun handle-message-end (request)
  "A message the host finished: from an assistant's, the limit an error states or the prompt the provider accepted (limits.lisp)."
  (let ((m (json-get request "message")))
    (when (equal (json-get m "role") "assistant")
      (let ((s (read-snapshot (json-get request "host"))))
        (if (equal (json-get m "stopReason") "error")
            (learn-limit s (strings-of (vector (json-get m "errorMessage") (json-get m "errorClassificationMessage"))))
            (let* ((u (json-get m "usage"))
                   (prompt (+ (num-or-0 (json-get u "input")) (num-or-0 (json-get u "cacheRead")) (num-or-0 (json-get u "cacheWrite")))))
              (when (> prompt 0) (learn-limit s nil prompt))))))
    (call-answer nil nil)))

(defun num-or-0 (v) (if (realp v) v 0))

;;; --- the request, with what is out of the context left out ----------------------------

(defun with-text (message before after)
  "MESSAGE with text parts put before and after its content."
  (let* ((content (json-get message "content"))
         (parts (cond ((stringp content) (list (json-object "type" "text" "text" content)))
                      ((json-array-p content) (coerce content 'list))))
         (text (lambda (s) (json-object "type" "text" "text" s)))
         (copy (copy-object message)))
    (setf (gethash "content" copy) (coerce (append (mapcar text before) parts (mapcar text after)) 'vector))
    copy))

(defun splice-request (messages drop stubs)
  "MESSAGES without the indices DROP, each stub line put where the core placed it:
before or after a message's content, in place of it (a tool result out on its
own), or as a message of its own."
  (let ((drop (coerce drop 'list)) (out '()))
    (loop for m across messages for i from 0
          do (let ((here (remove-if-not (lambda (st) (eql (json-get st "at") i)) stubs)))
               (dolist (st here) (when (equal (json-get st "how") "insert") (push (json-get st "message") out)))
               (unless (member i drop)
                 (let ((before (loop for st in here when (equal (json-get st "how") "prepend") collect (json-get st "text")))
                       (after (loop for st in here when (equal (json-get st "how") "append") collect (json-get st "text")))
                       ;; A result out on its own: its line in place of its content, the message kept for its call.
                       (m (let ((r (find "replace" here :key (lambda (st) (json-get st "how")) :test #'equal)))
                            (if r
                                (let ((copy (copy-object m)))
                                  (setf (gethash "content" copy) (vector (json-object "type" "text" "text" (json-get r "text"))))
                                  copy)
                                m))))
                   (push (if (or before after) (with-text m before after) m) out)))))
    (coerce (nreverse out) 'vector)))

(defun handle-request-context (request)
  "The host's next request (its context event): the messages to send instead (null: as they are), and the effects."
  (let* ((messages (coerce (json-get request "messages" #()) 'vector))
         (reply (context-for-host (read-snapshot (json-get request "host")) messages (eq (json-get request "tool") :true)))
         (drop (json-get reply "drop")) (stubs (coerce (json-get reply "stubs") 'list)))
    (let ((out (call-answer nil (append (appends +evict-entry-type+ (json-get reply "ops"))
                                   (and (stringp (json-get reply "notice")) (list (tell-effect (json-get reply "notice"))))))))
      (setf (gethash "messages" out) (if (or (plusp (length drop)) stubs) (splice-request messages drop stubs) :null))
      out)))
