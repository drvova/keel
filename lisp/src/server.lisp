;;;; server.lisp --- one request in, one response out.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The executable reads one JSON object from stdin and writes one to stdout,
;;;; then exits: src/core/lisp-core.ts runs it with spawnSync, so the recall
;;;; code that calls it stays synchronous, and nothing outlives a request. A
;;;; start costs ~5 ms (the dumped image is mapped, not loaded).
;;;;
;;;; search: entries the caller rendered (src/core/search-entries.ts)
;;;;   {"op":"search","query":Q,"docs":[{"role":R,"text":T,"files":[F...]}...],"floor":X?,"cap":N?}
;;;;   -> {"ok":true,"hits":[{"index":I,"snippet":S|null}...],"totalBeforeCap":N,"truncated":B}
;;;;
;;;; search-sessions: session files the core reads itself (src/core/recall-run.ts)
;;;;   {"op":"search-sessions","query":Q,
;;;;    "sources":[{"file":F,"ids":[ID...]|"active"|null,"skip":[N...],"session":S|null,"bytes":B}...],
;;;;    "maxBytes":B?,"maxEntries":N?}
;;;;   -> {"ok":true,"hits":[{"index":I,"role":R,"summary":S,"files":[F...]?,"session":S?,"snippet":S|null}...],
;;;;       "totalBeforeCap":N,"truncated":B,"searched":N}
;;;;   The first source is always read; each later one while the corpus stays
;;;;   within maxBytes and maxEntries (a later one is a project's earlier
;;;;   session, and `searched` counts those read).
;;;;
;;;; load: one source's entries as the core reads them, for the tests of reading a session
;;;;   {"op":"load","source":SOURCE} -> {"ok":true,"entries":[{"index","role","summary","files"?,"text"}...]}
;;;;
;;;; regex: one pattern as `new RegExp(P, "i")` on texts, for the parity test
;;;;   {"op":"regex","pattern":P,"texts":[T...]}
;;;;   -> {"ok":true,"status":"ok","results":[{"test":B,"search":I,"count":N}...]}
;;;;      or "status":"syntax" (JavaScript throws) or "unsupported" (a back-reference into a look-behind)
;;;;
;;;; summarize: a compaction's summary (src/core/summarize.ts compileSummary)
;;;;   {"op":"summarize","input":COMPILE-INPUT} -> {"ok":true,"text":T,"state":STATE,"sections":[S...]}
;;;;
;;;; compact: what a compaction does (src/compaction/plan.ts planCompaction)
;;;;   {"op":"compact","input":{branch, notes, keepUserTurns, fromCommand, reason,
;;;;    recovering, settings, ruleName, window, tokensBefore, hostSettings,
;;;;    selfStarted?, sessionFile, previousSummary, fileOps}}
;;;;   -> {"ok":true,"plan":PLAN}, PLAN with its "sizing" (the host's policy and
;;;;   trigger, the context's overhead and chars per token, the budgets); NOTES,
;;;;   parallel to BRANCH, carry for each live message what the host's
;;;;   convertToLlm makes of it (summary-input.ts toSummaryMessage), as it is and
;;;;   as its kept original, and its #N.
;;;;
;;;; cut: the cut alone (compaction.lisp), for the tests of where a compaction cuts
;;;;   {"op":"cut","action":"own"|"tail-budget"|"smart-keep"|"running-turn"|"whole-window",
;;;;    branch, notes, keep?, skip?, cut?, maxTokens?, minTokens?, charsPerToken?, requested?, smart?}
;;;;   -> {"ok":true,"cut":CUT}, CUT as cut.ts's OwnCutResult ({ok:false, reason} when there is none,
;;;;   null from running-turn and whole-window), or "keep" and "adjusted" for smart-keep.
;;;;
;;;; working-set: [Working Set] alone (working-set.lisp), for its tests
;;;;   {"op":"working-set","history":[MESSAGE...],"indices":[N...],"kept":[MESSAGE...],"maxChars":C}
;;;;   -> {"ok":true,"items":[{index,title,note,text}...],"lines":[L...],"shown":[N...]}
;;;;
;;;; request: a recall call's params or text as the core reads them (request.lisp), for its tests
;;;;   {"op":"request","params":P} or {"op":"request","args":TEXT}
;;;;   -> {"ok":true,"request":{scope, session?, action:{kind,...}, ignored:[PARAM...]},"note":N,
;;;;       "params":{...},"dropped":[D...]} (params and dropped for the tool's params)
;;;;
;;;; names: omp-vcc's own names and the limits its tools state (names.lisp), which src/names.ts copies
;;;;   {"op":"names"} -> {"ok":true,"names":{recallTool, recallParams, pinTool, ..., sessionRefMinChars}}
;;;;
;;;; context-edits: a branch as Pi's context holds it (src/core/context-edits.ts), for the parity test
;;;;   {"op":"context-edits","branch":[ENTRY...]} -> {"ok":true,"entries":[ENTRY...]}
;;;;   (op compact applies the same projection to its BRANCH and NOTES)
;;;;
;;;; settings: omp-vcc's config file (src/core/settings.ts), which the core reads and scaffolds itself
;;;;   {"op":"settings","path":P,"legacy":L|null,"scaffold":B}
;;;;   -> {"ok":true,"settings":SETTINGS}; with scaffold, the file is made whole
;;;;   first (from LEGACY, pi-vcc's file, when given and there is none at P).
;;;;
;;;; pin: one vcc_pin call or /…-pin, /…-unpin command (src/core/pins.ts)
;;;;   {"op":"pin","input":{call:{surface:"tool",params}|{surface:"command",name:"pin"|"unpin",args},
;;;;    branch:[the branch's pin entries and /clear boundaries], entries:[{type, message?}...]}}
;;;;   -> {"ok":true,"pin":{done, text, op?, severity?, agentNote?}}; OP is the
;;;;   omp-vcc.pin entry's data for the host to append.
;;;;
;;;; raw-capture: copy what omp may rewrite (src/hooks/raw-capture.ts captureNewEntries)
;;;;   {"op":"raw-capture","input":{file, entries:[the message entries since the last call],
;;;;    kept:[ids of them the binding keeps], lineage:B}}
;;;;   -> {"ok":true,"written":[ID...],"stored":B,"lineage":[ID...]?}; the core appends
;;;;   <file>.vcc-raw itself (STORED false: the write failed), and with LINEAGE
;;;;   reads the ids the file's and its parents' stores hold.
;;;;
;;;; placeholders: pointers on omp's placeholders (raw-capture.ts pointPlaceholders)
;;;;   {"op":"placeholders","input":{candidates:[{i, callId, text}], branch:[{id, toolCallId}],
;;;;    entries:[{type, id, message?}], kept:[ID...]}}
;;;;   -> {"ok":true,"replace":[{i, text}...]}
;;;;
;;;; args: a compaction command's text and the instructions the hook reads (src/core/compact-args.ts)
;;;;   {"op":"args","command":TEXT} -> {"ok":true,"followUpPrompt":P,"keepUserTurns":N|null,"instructions":I}
;;;;   {"op":"args","instructions":TEXT|null} -> {"ok":true,"fromCommand":B,"keepUserTurns":N|null,"followUpPrompt":P|null}
;;;;
;;;; limits: a model's learned window (src/core/model-limits.ts, src/hooks/window-limits.ts)
;;;;   {"op":"limits","action":"window","model":M,"hostName":H,"dir":D} -> {"ok":true,"window":{host?,learned?,effective?,source}}
;;;;   (each action takes the model M, or KEY, its provider/id)
;;;;   {"op":"limits","action":"learn","model":M,"dir":D,"window":N,"now":ISO?} -> {"ok":true,"recorded":B}
;;;;   {"op":"limits","action":"learned","model":M,"dir":D} -> {"ok":true,"window":N?}
;;;;   {"op":"limits","action":"policy","model":M,"dir":D} -> {"ok":true,"policy":P?}
;;;;   {"op":"limits","action":"record-policy","model":M,"dir":D,"policy":P} -> {"ok":true}
;;;;   {"op":"limits","action":"settled","model":M,"dir":D,"configPath":C,"provider":P,"ruleName":R,
;;;;    "hostName":H,"displayName":N,"modelsFile":F,"usedTokens":U} -> {"ok":true,"settled":{trigger, notice}?}
;;;;
;;;; outcome: what a compaction's outcome is told as (src/compaction/stats.ts, compact-feedback.ts, details.ts)
;;;;   {"op":"outcome","stats":S} -> {"ok":true,"line":L}
;;;;   {"op":"outcome","error":{message, mode, cancelNotice, hostName, branch:[{type}]}} -> {"ok":true,"text":T?,"severity":S?}
;;;;   {"op":"outcome","details":D} -> {"ok":true,"own":DETAILS?}
;;;;   {"op":"outcome","settings":S,"provider":P} -> {"ok":true,"handles":B}
;;;;
;;;; window: the window rules (src/core/window.ts), case by case
;;;;   {"op":"window","cases":[{"error":TEXT} | {ruleName, window, hostSettings|policy,
;;;;    recovering, tokensBefore, overheadTokens, workingSet}...]}
;;;;   -> {"ok":true,"results":[{"limit":N?} | {policy?, trigger?, autoCompacts, budgets}...]}
;;;;
;;;; recall: one vcc_recall call or /…-recall command (src/core/recall-run.ts recall)
;;;;   {"op":"recall","input":{call:{surface:"tool",params}|{surface:"command",name,args},
;;;;    sessionFile, projectFiles (newest first), cwd, lineageIds, hostBranch, contextWindow, skipCurrentTurn}}
;;;;   -> {"ok":true,"recall":{"ok":B,"text":T,"severity":S?}}
;;;;
;;;; Any failure answers {"ok":false,"error":MESSAGE}.
;;;;
;;;; Any error is answered, never thrown past MAIN: a caller that gets no
;;;; answer falls back, so a broken core costs speed, not recall.

(in-package #:omp-vcc)

(defun request-docs (request)
  (map 'vector
       (lambda (doc)
         (list (let ((role (json-get doc "role"))) (if (stringp role) role ""))
               (let ((text (json-get doc "text"))) (if (stringp text) text ""))
               (let ((files (json-get doc "files" #())))
                 (if (vectorp files) (remove-if-not #'stringp (coerce files 'list)) '()))))
       (let ((docs (json-get request "docs" #()))) (if (vectorp docs) docs #()))))

(defun handle-search (request)
  (let ((floor (json-get request "floor"))
        (cap (json-get request "cap")))
    (multiple-value-bind (hits total truncated)
        (search-docs (let ((q (json-get request "query"))) (if (stringp q) q ""))
                     (request-docs request)
                     :floor (if (realp floor) (coerce floor 'double-float) +relative-floor+)
                     :cap (if (integerp cap) cap +result-cap+))
      (cond
        ((eq hits :aborted) (aborted-reply total))
        (t
          (json-object "ok" :true
                       "hits" (map 'vector (lambda (h) (json-object "index" (car h) "snippet" (or (cdr h) :null))) hits)
                       "totalBeforeCap" total
                       "truncated" (bool truncated)))))))

(defun aborted-reply (message &optional (searched 0))
  "A search past its time budget: no hits, and why (search-entries.ts SearchAborted)."
  (json-object "ok" :true "hits" #() "totalBeforeCap" 0 "truncated" :false "aborted" message "searched" searched))

(defun source-entries (source)
  "The entries a source names, as (INDEX ROLE SUMMARY FILES TEXT): its file's
messages on the branch it names (ids, the file's own active branch, or all)
less the indices it skips."
  (let ((file (json-get source "file")))
    (when (stringp file)
      (multiple-value-bind (messages branch) (read-session file)
        (let* ((ids (json-get source "ids"))
               (allowed (cond ((json-array-p ids)
                               (let ((set (make-hash-table :test 'equal)))
                                 (loop for id across ids when (stringp id) do (setf (gethash id set) t))
                                 set))
                              ;; A file without entry ids (an old format) has no branch: all of it.
                              ((and (equal ids "active") (plusp (hash-table-count branch))) branch)))
               (skip (let ((s (json-get source "skip"))) (and (vectorp s) (coerce s 'list)))))
          (loop for (index id message) in messages
                when (and (or (null allowed) (and id (gethash id allowed)))
                          (not (member index skip)))
                  append (let ((rendered (ignore-errors (render-entry message))))
                           (and rendered (list (list* index (append rendered (list (search-text message)))))))))))))

(defun handle-search-sessions (request)
  (let* ((sources (let ((s (json-get request "sources" #()))) (if (vectorp s) (coerce s 'list) '())))
         (max-bytes (let ((b (json-get request "maxBytes"))) (if (realp b) b most-positive-fixnum)))
         (max-entries (let ((n (json-get request "maxEntries"))) (if (integerp n) n most-positive-fixnum)))
         (corpus '()) (count 0) (bytes 0) (searched 0))
    (loop for source in sources
          for first = t then nil
          do (let ((size (let ((b (json-get source "bytes"))) (if (realp b) b 0))))
               (when (and (not first) (> (+ bytes size) max-bytes) (plusp searched)) (return))
               (let* ((session (let ((s (json-get source "session"))) (and (stringp s) s)))
                      (entries (mapcar (lambda (e) (append e (list session))) (source-entries source))))
                 (when (and (not first) (> (+ count (length entries)) max-entries) (plusp searched)) (return))
                 (setf corpus (append corpus entries))
                 (incf count (length entries))
                 (unless first (incf bytes size) (incf searched)))))
    (let ((entries (coerce corpus 'vector))
          (floor (json-get request "floor"))
          (cap (json-get request "cap")))
      (multiple-value-bind (hits total truncated)
          (search-docs (let ((q (json-get request "query"))) (if (stringp q) q ""))
                       (map 'vector (lambda (e) (destructuring-bind (index role summary files text session) e
                                                  (declare (ignore index summary session))
                                                  (list role text files)))
                            entries)
                       :floor (if (realp floor) (coerce floor 'double-float) +relative-floor+)
                       :cap (if (integerp cap) cap +result-cap+))
        (cond
            ((eq hits :aborted) (aborted-reply total searched))
          (t
            (json-object "ok" :true
                         "hits" (map 'vector
                                     (lambda (h)
                                       (destructuring-bind (index role summary files text session) (aref entries (car h))
                                         (declare (ignore text))
                                         (json-object "index" index "role" role "summary" summary
                                                      "files" (and files (coerce files 'vector))
                                                      "session" session
                                                      "snippet" (or (cdr h) :null))))
                                     hits)
                         "totalBeforeCap" total
                         "truncated" (bool truncated)
                         "searched" searched)))))))

(defun handle-load (request)
  "A source's entries as recall renders them and search reads them (tests/session-read.test.ts)."
  (json-object "ok" :true
               "entries" (map 'vector (lambda (e)
                                        (destructuring-bind (index role summary files text) e
                                          (json-object "index" index "role" role "summary" summary
                                                       "files" (and files (coerce files 'vector)) "text" text)))
                              (source-entries (json-get request "source")))))

(defun handle-regex (request)
  "A pattern compiled as `new RegExp(P, \"i\")` and run on texts: what the regex
parity test compares with JavaScript's own."
  (let ((pattern (json-get request "pattern")) (texts (json-get request "texts" #())))
    (handler-case
        (let ((regex (compile-regex pattern)))
          (json-object "ok" :true "status" "ok"
                       "results" (map 'vector (lambda (text)
                                                (let ((units (string-units text)))
                                                  (json-object "test" (bool (regex-test regex units))
                                                               "search" (or (regex-search regex units) -1)
                                                               "count" (regex-count regex units))))
                                      texts)))
      (regex-syntax-error () (json-object "ok" :true "status" "syntax"))
      (regex-unsupported () (json-object "ok" :true "status" "unsupported")))))

(defun handle-summarize (request)
  "compileSummary on the CompileInput REQUEST carries in \"input\"."
  (multiple-value-bind (text state sections) (compile-summary (json-get request "input"))
    (json-object "ok" :true "text" text "state" (state-json state) "sections" (coerce sections 'vector))))

(defun handle-compact (request)
  "planCompaction on the PlanInput REQUEST carries in \"input\", the host's convertToLlm already applied."
  (json-object "ok" :true "plan" (plan-compaction (json-get request "input"))))

(defun cut-json (cut)
  "A cut as cut.ts's OwnCutResult."
  (cond ((null cut) :null)
        ((not (cut-p cut)) (json-object "ok" :false "reason" (cut-reason-name cut)))
        (t (let ((o (json-object "ok" :true
                                 "messages" (map 'vector #'item-live (cut-items cut))
                                 "selectedIds" (map 'vector #'item-id (cut-items cut))
                                 "firstKeptEntryId" (cut-first-kept cut)
                                 "compactAll" (if (cut-compact-all cut) :true :false)
                                 "keptUserTurns" (cut-kept-user-turns cut)
                                 "totalUserTurns" (cut-total-user-turns cut)
                                 "keepFallbackToCompactAll" (if (cut-fallback cut) :true :false))))
             (when (cut-budget-cut cut) (setf (gethash "budgetCut" o) (cut-budget-cut cut)))
             o))))

(defun json-cut (v live)
  "The cut a test hands back (cut-json's shape) on the LIVE items it was made of."
  (if (not (eq (json-get v "ok") :true))
      (if (equal (json-get v "reason") "no_live_messages") :no-live-messages :too-few-live-messages)
      (%make-cut :items (subseq live 0 (length (json-get v "messages" #())))
                 :first-kept (json-get v "firstKeptEntryId")
                 :compact-all (eq (json-get v "compactAll") :true)
                 :kept-user-turns (json-get v "keptUserTurns") :total-user-turns (json-get v "totalUserTurns")
                 :fallback (eq (json-get v "keepFallbackToCompactAll") :true)
                 :budget-cut (json-get v "budgetCut"))))

(defun handle-cut (request)
  "One of the cut's steps on REQUEST's branch, as the context holds it."
  (multiple-value-bind (branch notes)
      (apply-context-edits (coerce (json-get request "branch" #()) 'vector) (coerce (json-get request "notes" #()) 'vector))
    (let ((action (json-get request "action"))
          (skip (strings-of (json-get request "skip" #())))
          (max (json-get request "maxTokens"))
          (per-token (let ((c (json-get request "charsPerToken"))) (if (realp c) c +default-chars-per-token+))))
      (cond ((equal action "own") (json-object "ok" :true "cut" (cut-json (build-own-cut branch notes (json-get request "keep") skip))))
            ((equal action "tail-budget")
             (let ((cut (json-cut (json-get request "cut") (live-items branch notes))))
               (json-object "ok" :true "cut" (cut-json (if (cut-p cut) (apply-tail-budget branch notes cut max per-token skip) cut)))))
            ((equal action "running-turn") (json-object "ok" :true "cut" (cut-json (running-turn-cut branch notes max per-token skip))))
            ((equal action "whole-window") (json-object "ok" :true "cut" (cut-json (whole-window-cut branch notes skip))))
            ((equal action "smart-keep")
             (multiple-value-bind (keep adjusted)
                 (resolve-smart-keep branch notes (let ((r (json-get request "requested"))) (and (realp r) r))
                                     (eq (json-get request "smart") :true) skip (json-get request "minTokens") max per-token)
               (json-object "ok" :true "keep" keep "adjusted" (if adjusted :true :false))))
            (t (json-object "ok" :false "error" "cut: unknown action"))))))

(defun handle-working-set (request)
  "The items [Working Set] picks of REQUEST's history, and the section's lines."
  (let* ((max (json-get request "maxChars"))
         (items (select-working-set (coerce (json-get request "history" #()) 'list) (coerce (json-get request "indices" #()) 'list)
                                    (coerce (json-get request "kept" #()) 'list) max)))
    (multiple-value-bind (lines shown) (format-working-set items max)
      (json-object "ok" :true
                   "items" (map 'vector (lambda (i) (json-object "index" (ws-item-index i) "title" (ws-item-title i)
                                                                 "note" (ws-item-note i) "text" (ws-item-text i)))
                                items)
                   "lines" (coerce lines 'vector) "shown" (coerce shown 'vector)))))

(defun action-json (action)
  "A request's action as recall-request.ts wrote it."
  (destructuring-bind (kind &rest rest) action
    (case kind
      (:search (json-object "kind" "search" "query" (first rest) "page" (second rest)))
      (:expand (json-object "kind" "expand" "indices" (coerce (first rest) 'vector)))
      (:range (json-object "kind" "range" "range" (coerce (first rest) 'vector) "page" (second rest)))
      ((:touched :sessions) (json-object "kind" (string-downcase (symbol-name kind)) "page" (first rest)))
      (:recent (json-object "kind" "recent"))
      (:drill (destructuring-bind (index path full offset limit) rest
                (json-object "kind" "drill" "target" (json-object "index" index "pathPattern" path "full" (if full :true :false)
                                                                   "offset" offset "limit" limit))))
      (t (json-object "kind" (string-downcase (symbol-name kind)))))))

(defun handle-request-parse (request)
  "A recall call's params (or a command's text) read as a request, and the note on what it ignored."
  (let* ((args (json-get request "args"))
         (req (if (stringp args) (parse-command-request args) (parse-tool-request (json-get request "params"))))
         (out (json-object "ok" :true
                           "request" (let ((o (json-object "scope" (getf req :scope) "action" (action-json (getf req :action))
                                                           "ignored" (map 'vector #'car (getf req :ignored)))))
                                       (when (getf req :session) (setf (gethash "session" o) (getf req :session)))
                                       o)
                           "note" (ignored-note req))))
    (unless (stringp args)
      (multiple-value-bind (params dropped) (normalize-tool-params (json-get request "params"))
        (let ((p (json-object)))
          (loop for (key value) on params by #'cddr
                when value do (setf (gethash (string-downcase (symbol-name key)) p) (if (listp value) (coerce value 'vector) value)))
          (setf (gethash "params" out) p (gethash "dropped" out) (coerce dropped 'vector)))))
    out))

(defun handle-recall (request)
  "recall-run.ts recall() on the call REQUEST carries in \"input\"."
  (multiple-value-bind (ok text severity) (run-recall (json-get request "input"))
    (json-object "ok" :true "recall" (json-object "ok" (if ok :true :false) "text" text "severity" severity))))

(defun handle-context-edits (request)
  "The branch REQUEST carries, Pi's context edits applied (context-edits.lisp)."
  (let ((branch (coerce (json-get request "branch" #()) 'vector)))
    (json-object "ok" :true "entries" (values (apply-context-edits branch (make-array (length branch) :initial-element nil))))))

(defun handle-settings (request)
  "The settings at REQUEST's path, the file scaffolded first when it asks."
  (let ((path (json-get request "path")))
    (unless (stringp path) (return-from handle-settings (json-object "ok" :false "error" "settings: no path")))
    (when (eq (json-get request "scaffold") :true)
      (scaffold-settings path (let ((l (json-get request "legacy"))) (and (stringp l) l))))
    (json-object "ok" :true "settings" (load-settings path))))

(defun handle-pin (request)
  "A pin call (pins.lisp run-pin): what to tell, and the op to append."
  (multiple-value-bind (done text op severity note) (run-pin (json-get request "input"))
    (json-object "ok" :true "pin" (json-object "done" (if done :true :false) "text" text "op" op "severity" severity "agentNote" note))))

(defun handle-raw-capture (request)
  "Copy the entries REQUEST carries that omp may rewrite into the store (raw-capture.lisp)."
  (multiple-value-bind (written stored lineage) (capture-entries (json-get request "input"))
    (json-object "ok" :true "written" (coerce written 'vector) "stored" (if stored :true :false)
                 "lineage" (and lineage (coerce lineage 'vector)))))

(defun handle-placeholders (request)
  (json-object "ok" :true "replace" (coerce (point-placeholders (json-get request "input")) 'vector)))

(defun handle-limits (request)
  (let* ((action (json-get request "action")) (model (json-get request "model")) (dir (json-get request "dir"))
         ;; A model, or its provider/id key as the learned-limits file names it.
         (key (let ((k (json-get request "key"))) (if (stringp k) k (model-key model)))))
    (unless (stringp dir) (return-from handle-limits (json-object "ok" :false "error" "limits: no dir")))
    (cond ((equal action "window") (json-object "ok" :true "window" (window-of model (json-get request "hostName") dir)))
          ((equal action "learn")
           (json-object "ok" :true "recorded"
                        (if (record-learned-window dir key (json-get request "window")
                                                   (let ((now (json-get request "now"))) (if (stringp now) now (iso-now))))
                            :true :false)))
          ((equal action "learned") (json-object "ok" :true "window" (learned-window dir key)))
          ((equal action "policy") (json-object "ok" :true "policy" (learned-host-policy dir key)))
          ((equal action "record-policy") (record-host-policy dir key (json-get request "policy")) (json-object "ok" :true))
          ((equal action "settled")
           (let ((path (json-get request "configPath")))
             (json-object "ok" :true "settled"
                          (and (stringp path) (handles-host-compactions-p (load-settings path) (json-get request "provider"))
                               (settled-compaction request)))))
          (t (json-object "ok" :false "error" "limits: unknown action")))))

(defun handle-outcome (request)
  (cond ((nth-value 1 (gethash "stats" request)) (json-object "ok" :true "line" (format-compaction-stats (json-get request "stats"))))
        ((nth-value 1 (gethash "error" request))
         (multiple-value-bind (text severity) (compact-error-feedback (json-get request "error"))
           (json-object "ok" :true "text" text "severity" severity)))
        ((nth-value 1 (gethash "details" request)) (json-object "ok" :true "own" (vcc-details-of (json-get request "details"))))
        (t (json-object "ok" :true "handles" (if (handles-host-compactions-p (json-get request "settings") (json-get request "provider")) :true :false)))))

(defun handle-window (request)
  "The window rules on each of REQUEST's cases (window.lisp window-case)."
  (json-object "ok" :true "results" (map 'vector #'window-case (json-get request "cases" #()))))

(defun handle-request (request)
  "The response object to the parsed REQUEST."
  (let ((op (json-get request "op")))
    (cond ((equal op "search") (handle-search request))
          ((equal op "search-sessions") (handle-search-sessions request))
          ((equal op "load") (handle-load request))
          ((equal op "regex") (handle-regex request))
          ((equal op "summarize") (handle-summarize request))
          ((equal op "compact") (handle-compact request))
          ((equal op "cut") (handle-cut request))
          ((equal op "names") (json-object "ok" :true "names" (names-json)))
          ((equal op "request") (handle-request-parse request))
          ((equal op "working-set") (handle-working-set request))
          ((equal op "recall") (handle-recall request))
          ((equal op "window") (handle-window request))
          ((equal op "settings") (handle-settings request))
          ((equal op "pin") (handle-pin request))
          ((equal op "raw-capture") (handle-raw-capture request))
          ((equal op "args") (handle-args request))
          ((equal op "limits") (handle-limits request))
          ((equal op "outcome") (handle-outcome request))
          ((equal op "placeholders") (handle-placeholders request))
          ((equal op "context-edits") (handle-context-edits request))
          (t (json-object "ok" :false "error" (format nil "unknown op ~a" (json-string (or op :null))))))))

(defun read-stdin ()
  "Everything on stdin, decoded from UTF-8. Read as bytes and decoded at once:
a character stream decodes one character at a time, ten times slower on a
large request."
  (let ((in (sb-sys:make-fd-stream 0 :input t :element-type '(unsigned-byte 8) :buffering :full))
        (chunks '()) (total 0))
    (loop for chunk = (make-array 1048576 :element-type '(unsigned-byte 8))
          for n = (read-sequence chunk in)
          while (plusp n)
          do (push (cons chunk n) chunks) (incf total n))
    (let ((bytes (make-array total :element-type '(unsigned-byte 8))) (at 0))
      (dolist (c (nreverse chunks))
        (replace bytes (car c) :start1 at :end2 (cdr c))
        (incf at (cdr c)))
      (sb-ext:octets-to-string bytes :external-format :utf-8))))

(defun main ()
  "Entry point of the dumped executable."
  (let ((response (handler-case
                      (handle-request (parse-json (read-stdin)))
                    ;; The heap or the stack running out too: the caller says the core failed.
                    (serious-condition (e) (json-object "ok" :false "error" (princ-to-string e))))))
    (write-json response *standard-output*)
    (terpri *standard-output*)
    (finish-output *standard-output*)
    (sb-ext:exit :code 0 :abort t)))
