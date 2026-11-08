;;;; host.lisp --- what the host knows at an event, as the one snapshot every op reads.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Each op the TypeScript side sends for a host event carries one snapshot
;;;; (src/host.ts): which host, keel's config file, the
;;;; session file, the working directory, the model and the context the host
;;;; counted, the session's entry tree as a skeleton, and the branch the session
;;;; manager is on. From it the core counts #N, finds the branch, loads the
;;;; settings, works out the window and records the host's policy itself, so no
;;;; caller reduces the session its own way.
;;;;
;;;; The skeleton is every entry in file order with the bulky parts left out
;;;; (src/host.ts skeleton): a message is its role, timestamp,
;;;; attribution and a tool result's call id; a compaction keeps where its kept
;;;; tail starts (firstKeptEntryId, providerReplayThroughEntryId); keel's own
;;;; pin and evict entries keep their data. That is what #N, the branch, the
;;;; turns, the pins and the evictions need: eviction ties a request's messages
;;;; to #N by role, timestamp and call id, and tells the user's requests by
;;;; attribution. Content comes from the session file (recall) or from the event
;;;; itself (a compaction's branch).

(in-package #:keel)

(defstruct (snapshot (:constructor %make-snapshot))
  name display-name models-file config-path session-file cwd model context-tokens tree branch-ids)

(defun read-snapshot (json)
  "The snapshot an op carries in \"host\"."
  (flet ((str (key) (let ((v (json-get json key))) (and (stringp v) v))))
    (%make-snapshot :name (str "name") :display-name (str "displayName")
                    :models-file (str "modelsFile") :config-path (str "configPath")
                    :session-file (let ((f (str "sessionFile"))) (and f (plusp (length f)) f))
                    :cwd (or (str "cwd") "")
                    :model (let ((m (json-get json "model"))) (and (json-object-p m) m))
                    :context-tokens (let ((n (json-get json "contextTokens"))) (and (realp n) n))
                    :tree (coerce (json-get json "tree" #()) 'vector)
                    :branch-ids (strings-of (json-get json "branch")))))

(defun snapshot-config-dir (s)
  "Where keel keeps what it learns, beside its config file."
  (path-directory (snapshot-config-path s)))

(defun snapshot-settings (s) (load-settings (snapshot-config-path s)))

(defun snapshot-window (s)
  "The model's window: the host's, or the smaller one an overflow error stated (limits.lisp)."
  (window-of (snapshot-model s) (snapshot-name s) (snapshot-config-dir s)))

(defun snapshot-index (s) (index-by-id (snapshot-tree s)))

(defun snapshot-branch (s)
  "The skeleton's entries on the session manager's branch, in its order."
  (let ((by-id (make-hash-table :test 'equal)))
    (loop for e across (snapshot-tree s)
          for id = (json-get e "id")
          when (stringp id) do (setf (gethash id by-id) e))
    (coerce (loop for id in (snapshot-branch-ids s)
                  for e = (gethash id by-id)
                  when e collect e)
            'vector)))

(defun snapshot-lineage-ids (s)
  "The ids on the branch, or every entry's when the host gives no branch."
  (or (snapshot-branch-ids s)
      (loop for e across (snapshot-tree s)
            for id = (json-get e "id")
            when (and (stringp id) (plusp (length id))) collect id)))

(defun snapshot-handles-p (s settings)
  "Whether keel answers the host's own compactions for this model's provider."
  (handles-host-compactions-p settings (json-get (snapshot-model s) "provider")))

;;; --- what each op makes of it -----------------------------------------------------

(defun model-chars-per-token (s)
  "The model's chars per token as a request last measured them, or the heuristic."
  (or (learned-chars-per-token (snapshot-config-dir s) (model-key (snapshot-model s))) +default-chars-per-token+))

(defun learn-limit (s errors &optional prompt)
  "Keep the limit the first of ERRORS states for the model, when it is below the
host's window (or the host knows none); T when it was recorded. PROMPT, the
prompt tokens of a request the provider answered, is kept as the largest it
accepted."
  (when (realp prompt) (record-evidence (snapshot-config-dir s) (model-key (snapshot-model s)) :prompt prompt))
  (let* ((limit (loop for e in errors for l = (limit-from-overflow-error e) when l return l))
         (model (snapshot-model s))
         (host (json-get model "contextWindow")))
    (and limit (or (not (realp host)) (not (> host 0)) (< limit host))
         (record-learned-window (snapshot-config-dir s) (model-key model) limit))))

(defun settled-check (s)
  "Once a run settles, whether keel compacts in the host's stead, and the note that says so."
  (when (snapshot-handles-p s (snapshot-settings s))
    (settled-compaction :model (snapshot-model s) :dir (snapshot-config-dir s) :host (snapshot-name s)
                        :display-name (snapshot-display-name s) :models-file (snapshot-models-file s)
                        :used-tokens (snapshot-context-tokens s))))

(defun recall-input (s call project-files)
  "What a recall call reads: the session file, the project's other files (newest first), the path, the window."
  (json-object "call" call
               "sessionFile" (snapshot-session-file s)
               "projectFiles" project-files
               "cwd" (snapshot-cwd s)
               "lineageIds" (coerce (snapshot-lineage-ids s) 'vector)
               "hostBranch" (map 'vector (lambda (e) (json-object "type" (json-get e "type") "role" (json-get (json-get e "message") "role")))
                                 (snapshot-branch s))
               "contextWindow" (json-get (snapshot-window s) "effective")
               ;; The agent has its current turn in context, and its question would match itself;
               ;; a command adds no user message, so the last one there belongs to a finished turn.
               "skipCurrentTurn" (bool (equal (json-get call "surface") "tool"))))

(defun pin-input (s call)
  (json-object "call" call
               "branch" (remove-if-not (lambda (e) (or (pin-entry-p e) (equal (json-get e "type") +reset-entry-type+)))
                                       (snapshot-branch s))
               "entries" (snapshot-tree s)))

(defun placeholders-input (s candidates kept)
  "What pointing omp's placeholders reads: the request's one-text-block tool results, the branch's results by call id, #N, the kept ids."
  (let ((branch (loop for e across (snapshot-branch s)
                      for m = (json-get e "message")
                      when (and (equal (json-get e "type") "message") (equal (json-get m "role") "toolResult")
                                (stringp (json-get m "toolCallId")))
                        collect (json-object "id" (or (json-get e "id") :null) "toolCallId" (json-get m "toolCallId")))))
    (json-object "candidates" candidates "branch" (coerce branch 'vector) "entries" (snapshot-tree s) "kept" kept)))

(defun compact-error-input (s error)
  "What /keel tells when the host's compaction it asked for did not happen."
  (let ((input (copy-object error)))
    (setf (gethash "displayName" input) (snapshot-display-name s)
          (gethash "branch" input) (snapshot-branch s))
    input))

;;; --- turns out of the context (evict.lisp) -----------------------------------------

(defun context-readout (s)
  "How full the context is, for the end of a keel tool's result while eviction
is on: models judge their own context's length poorly past a few thousand tokens
(Context Language Models, appendix G), so each result says it, as that paper's
tools do. Written once into the result, it reads the same on every later
request. NIL when the host has not counted the context, or the trigger is unknown."
  (let ((tokens (snapshot-context-tokens s)) (trigger (snapshot-trigger s)))
    (and (realp tokens) (realp trigger) (> trigger 0)
         ;; What is left, as budget-aware agents are told it (Liu et al., arXiv 2511.17006): a model
         ;; reads a remaining budget better than a share.
         (format nil "[context: ~~~a tokens, ~d% of where the host compacts (~~~a); ~~~a left]"
                 (js-string-of (round tokens)) (round (* 100 tokens) trigger) (js-string-of (round trigger))
                 (js-string-of (max 0 (round (- trigger tokens))))))))

(defun with-readout (s text)
  "TEXT with the context readout after it, when eviction is on and there is one."
  (let ((readout (and (eq (json-get (snapshot-settings s) "evict") :true) (context-readout s))))
    (if (and readout (stringp text)) (format nil "~a~%~a" text readout) text)))

(defun snapshot-count (s) "How many entries #N counts now: the next one's #N." (count-if #'counted-entry-p (snapshot-tree s)))

(defun snapshot-trigger (s)
  "Where the host compacts on the model's window, by its last recorded policy (its defaults before one is)."
  (let* ((w (snapshot-window s)) (effective (json-get w "effective")))
    (and (realp effective) (> effective 0)
         (trigger-for effective nil nil (learned-host-policy (snapshot-config-dir s) (model-key (snapshot-model s))) (snapshot-name s)))))

(defun context-for-host (s messages tool)
  "The host's next request MESSAGES with what is out of the context left out: the
indices to drop, the lines to put in their place (where, and as what), the
evictions keel records itself as the context fills (the evict setting), the
note telling the model how full its context is (TOOL: keel_context is
registered), and what to tell the user."
  (let* ((auto (eq (json-get (snapshot-settings s) "evict") :true))
         (trigger (and auto (snapshot-trigger s))) (count (snapshot-count s)) (branch (snapshot-branch s))
         (file (snapshot-session-file s))
         ;; The context's file (mirror.lisp): with keel_context there and a session file to put it beside.
         (mirror (and tool (stringp file) (mirror-path file)))
         (edit-ops '()) (ignored nil))
    ;; The agent's edit of the file since the last request: ops of the ledger, seen by this request already.
    (when mirror
      (multiple-value-setq (edit-ops ignored) (mirror-edits file branch (snapshot-index s) count))
      (stamp-call edit-ops branch)
      (when edit-ops
        (setf branch (concatenate 'vector branch
                                  (mapcar (lambda (op) (json-object "type" "custom" "customType" +evict-entry-type+ "data" op)) edit-ops)))))
    (multiple-value-bind (drop stubs ops before after n-of dropped outs turns fit reread reread-trials rates credit)
        (let ((*chars-per-token* (model-chars-per-token s)))
          (evict-request branch (snapshot-index s) (coerce messages 'vector) :file file
                         :trigger trigger :auto auto :count count :mark tool :mirror mirror
                         :reread-prior (learned-reread (snapshot-config-dir s) (model-key (snapshot-model s)))
                         :credit-prior (learned-recall-by-kind (snapshot-config-dir s) (model-key (snapshot-model s)))))
      ;; What this request measured of the model's tokens, kept for the next session and for keel_context;
      ;; and, once the session has shown enough of it, how often the model recalls a turn again (feedback.lisp).
      (let ((by-kind (credit-shown rates credit)))
        (when (or fit (and reread (>= reread-trials +reread-prior-weight+)) by-kind)
          (record-evidence (snapshot-config-dir s) (model-key (snapshot-model s)) :chars-per-token fit
                           :reread (and (>= reread-trials +reread-prior-weight+) reread)
                           :recall-by-kind by-kind)))
      (stamp-call ops branch)
      (when mirror
        (write-mirror file (render-mirror (coerce messages 'vector) n-of dropped outs turns (read-inserts branch))))
      (multiple-value-bind (note note-op)
          ;; After an eviction this request, the context just shrank: no note.
          (and auto (null ops) (budget-note branch (snapshot-index s) after trigger tool count))
        (json-object "drop" (coerce drop 'vector)
                     "stubs" (map 'vector (lambda (st)
                                            (destructuring-bind ((at . how) . text) st
                                              (json-object "at" at "how" how "text" text
                                                           ;; A line of its own stands where the turns were, as the user's.
                                                           "message" (and (equal how "insert")
                                                                          (json-object "role" "user" "content" (vector (json-object "type" "text" "text" text))
                                                                                       "timestamp" (json-get (aref (coerce messages 'vector) at) "timestamp"))))))
                                  stubs)
                     "ops" (coerce (append edit-ops ops (and note-op (list note-op))) 'vector)
                     "note" note
                     "notice" (let ((lines (remove nil (list (and (or edit-ops ignored) (mirror-notice edit-ops ignored))
                                                             (and ops (auto-notice ops before after))))))
                                (and lines (join-strings lines (string #\Newline)))))))))

(defun evict-for-host (s call)
  "One keel_context call or evict command: what to tell, and the entries to append. Turn sizes come from the session file."
  (let ((chars (make-hash-table)) (by-n (make-hash-table)) (file (snapshot-session-file s))
        (*chars-per-token* (model-chars-per-token s)))
    (when (and file (probe-file (native-path file)))
      (loop for (index nil message) in (read-session file)
            do (setf (gethash index chars) (message-chars message) (gethash index by-n) message)))
    (multiple-value-bind (text ops) (run-evict call (snapshot-branch s) (snapshot-index s) chars by-n (snapshot-count s))
      (json-object "text" (if (equal (json-get call "surface") "tool") (with-readout s text) text)
                   "ops" (coerce (stamp-call ops (snapshot-branch s)) 'vector)))))

;;; --- a compaction, in two calls --------------------------------------------------

(defun projected-branch (event)
  "The event's branch as the context holds it: Pi's context edits applied, once."
  (let ((raw (coerce (json-get event "branchEntries" #()) 'vector)))
    (values (apply-context-edits raw (make-array (length raw) :initial-element nil)))))

(defun compaction-reply (plan from-command follow-up tokens-before)
  "The plan as the hook acts on it: pass to the host, cancel (with what to tell), or the compaction in the host's own shape."
  (let ((kind (json-get plan "kind")))
    (cond ((equal kind "step_aside") (json-object "kind" "pass"))
          ((equal kind "cancel") (json-object "kind" "cancel" "notice" (json-get plan "notice")))
          (t (json-object "kind" "compact"
                          "compaction" (json-object "summary" (json-get plan "summary") "details" (json-get plan "details")
                                                    "tokensBefore" tokens-before "firstKeptEntryId" (json-get plan "firstKeptEntryId"))
                          "statsLine" (format-compaction-stats (json-get plan "stats"))
                          "fromCommand" (bool from-command)
                          "followUpPrompt" follow-up)))))

(defun debug-record (plan event from-command)
  "What keel-debug.json holds of the last pass when the debug setting is on."
  (json-object "compaction" (json-object "reason" (json-get event "reason") "willRetry" (json-get event "willRetry"))
               "fromCommand" (bool from-command)
               "kind" (json-get plan "kind") "why" (json-get plan "why") "cutReason" (json-get plan "cutReason")
               "liveRoles" (json-get plan "liveRoles") "budgetCut" (json-get (json-get plan "stats") "budgetCut")
               "summarized" (json-get plan "summarized") "growth" (json-get plan "growth")
               "firstKeptEntryId" (json-get plan "firstKeptEntryId")
               "tokensBefore" (json-get event "tokensBefore")
               "tokenEstimate" (json-get (json-get plan "sizing") "tokenEstimate")
               "summaryLength" (let ((s (json-get plan "summary"))) (and (stringp s) (js-length s)))
               "summaryPreview" (let ((s (json-get plan "summary"))) (and (stringp s) (js-slice s 0 (min 500 (js-length s)))))
               "sections" (json-get plan "sections")))

(defun compact-for-host (s event converted)
  "A session_before_compact for the host in snapshot S. Without CONVERTED, the
messages the host's convertToLlm must convert first (kind convert), unless the
pass is not keel's to answer; with it, what the hook returns."
  (let ((settings (snapshot-settings s)))
    (multiple-value-bind (from-command keep follow-up) (parse-instructions (json-get event "customInstructions"))
      (when (and (not from-command) (not (snapshot-handles-p s settings)))
        (return-from compact-for-host (json-object "kind" "pass")))
      (let* ((branch (projected-branch event))
             (file (snapshot-session-file s)))
        (multiple-value-bind (live originals) (host-messages branch file)
          (let ((wanted (messages-to-convert live originals)))
            (when (and wanted (not (json-array-p converted)))
              (return-from compact-for-host (json-object "kind" "convert" "messages" (coerce wanted 'vector))))
            (let* ((reason (json-get event "reason"))
                   (will-retry (json-get event "willRetry"))
                   ;; What the agent recalled lately, which [Working Set] brings back first (feedback.lisp).
                   (*recalled* (let ((b (snapshot-branch s)))
                                 (recalled-newest-first (recent-recalls (read-recalls b) (branch-turns b (snapshot-index s))))))
                   (window (snapshot-window s))
                   (input (json-object "settings" settings
                                       "keepUserTurns" (or keep :null)
                                       "fromCommand" (bool from-command)
                                       "reason" reason
                                       "recovering" (bool (and (not from-command) (recovery-p reason will-retry)))
                                       "ruleName" (snapshot-name s)
                                       "window" (json-get window "effective")
                                       "windowSource" (json-get window "source")
                                       "willRetry" will-retry
                                       "tokensBefore" (json-get event "tokensBefore")
                                       "hostSettings" (json-get event "hostSettings")
                                       "selfStarted" (and (eq (json-get event "selfStarted") :true)
                                                          (json-object "usedTokens" (or (snapshot-context-tokens s) :null)))
                                       ;; Whether a finished turn is left to take out (evict.lisp), for the evict setting's policy.
                                       "evictRoom" (bool (room-to-evict-p (snapshot-branch s) (snapshot-index s)))
                                       "sessionFile" file
                                       "previousSummary" (json-get event "previousSummary")
                                       "fileOps" (json-get event "fileOps")))
                   (plan (plan-compaction input branch (host-notes branch live originals (or converted #()) (snapshot-index s)))))
              ;; Kept beside a learned window, for the compaction keel starts in the host's stead.
              (record-host-policy (snapshot-config-dir s) (model-key (snapshot-model s)) (json-get (json-get plan "sizing") "policy"))
              (let ((reply (compaction-reply plan from-command follow-up (json-get event "tokensBefore"))))
                ;; With the debug setting on, the pass's decisions beside the config; a debug write never breaks a compaction.
                (when (eq (json-get settings "debug") :true)
                  (ignore-errors
                   (write-text-file (join-path (snapshot-config-dir s) "keel-debug.json")
                                    (json-pretty-string (debug-record plan event from-command)))))
                reply))))))))
