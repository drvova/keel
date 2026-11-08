;;;; server.lisp --- one request in, one response out.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The executable reads one JSON object from stdin and writes one to stdout,
;;;; then exits; with --serve it answers the same requests one after another
;;;; in one long-lived process (live.lisp), which is how src/core.ts
;;;; runs it where the system has named pipes. Either way the callers stay
;;;; synchronous. A start costs ~5 ms (the dumped image is mapped, not loaded).
;;;;
;;;; search: recall's search over one session file, for the search tests (tests/support/pairs.ts)
;;;;   {"op":"search","file":F,"query":Q,"floor":X?,"cap":N?}
;;;;   -> {"ok":true,"hits":[{"index":I,"role":R,"summary":S,"files":[F...]?,"snippet":S|null}...],
;;;;       "totalBeforeCap":N,"truncated":B} or {"ok":true,"hits":[],"aborted":MESSAGE}
;;;;
;;;; load: one source's entries as the core reads them, for the tests of reading a session
;;;;   {"op":"load","source":SOURCE} -> {"ok":true,"entries":[{"index","role","summary","files"?,"text"}...]}
;;;;
;;;; regex: one pattern as `new RegExp(P, "i")` on texts, for the parity test
;;;;   {"op":"regex","pattern":P,"texts":[T...]}
;;;;   -> {"ok":true,"status":"ok","results":[{"test":B,"search":I,"count":N}...]}
;;;;      or "status":"syntax" (JavaScript throws) or "unsupported" (a back-reference into a look-behind)
;;;;   {"op":"regex","cases":[{"pattern":P,"texts":[T...]}...]}
;;;;   -> {"ok":true,"cases":[the answer above, one per case in order]}
;;;;
;;;; summarize: a compaction's summary (summary.lisp compile-summary), for tests/support/compile.ts
;;;;   {"op":"summarize","input":COMPILE-INPUT} -> {"ok":true,"text":T,"state":STATE,"sections":[S...]}
;;;;
;;;; compact: a session_before_compact, in two calls (src/compaction.ts; host.lisp compact-for-host)
;;;;   {"op":"compact","host":SNAPSHOT,"event":EVENT,"converted":[MESSAGE...]?}
;;;;   -> {"ok":true,"kind":"pass"} when the pass is not keel's; without
;;;;   CONVERTED, {"ok":true,"kind":"convert","messages":[M...]}, what the host's
;;;;   convertToLlm must convert, asked again with its answers in that order; with
;;;;   them, the cancel or the compaction in the host's own result shape.
;;;;
;;;; cut: the cut alone (compaction.lisp), for the tests of where a compaction cuts
;;;;   {"op":"cut","action":"own"|"tail-budget"|"smart-keep"|"running-turn"|"whole-window",
;;;;    branchEntries, converted?, keep?, skip?, cut?, maxTokens?, minTokens?, charsPerToken?, requested?, smart?}
;;;;   -> like op compact, first {"ok":true,"kind":"convert","messages":[M...]} without CONVERTED;
;;;;   then {"ok":true,"cut":CUT}, CUT as cut-json writes it ({ok:false, reason} when there is
;;;;   none, null from running-turn and whole-window), or "keep" and "adjusted" for smart-keep.
;;;;
;;;; working-set: [Working Set] alone (working-set.lisp), for its tests
;;;;   {"op":"working-set","history":[MESSAGE...],"indices":[N...],"kept":[MESSAGE...],"maxChars":C,"recalled":[N...]?}
;;;;   -> {"ok":true,"items":[{index,title,note,text}...],"lines":[L...],"shown":[N...]}
;;;;
;;;; request: a recall call's params or text as the core reads them (request.lisp), for its tests
;;;;   {"op":"request","params":P} or {"op":"request","args":TEXT}
;;;;   -> {"ok":true,"request":{scope, session?, action:{kind,...}, ignored:[PARAM...]},"note":N,
;;;;       "params":{...},"dropped":[D...]} (params and dropped for the tool's params)
;;;;
;;;; names: keel's own names and the limits its tools state (names.lisp), for the tests
;;;;   {"op":"names"} -> {"ok":true,"names":{recallTool, recallParams, pinTool, ..., sessionRefMinChars}}
;;;;
;;;; context-edits: a branch as Pi's context holds it (context-edits.lisp), for the parity test
;;;;   {"op":"context-edits","branch":[ENTRY...]} -> {"ok":true,"entries":[ENTRY...]}
;;;;   (op compact applies the same projection to its BRANCH and NOTES)
;;;;
;;;; settings: keel's config file (src/settings.ts), which the core reads and scaffolds itself
;;;;   {"op":"settings","path":P,"legacy":L|null,"scaffold":B}
;;;;   -> {"ok":true,"settings":SETTINGS}; with scaffold, the file is made whole
;;;;   first (from LEGACY, an earlier name's file, when given and there is none at P).
;;;;
;;;; surface: the tools and commands a binding registers (surface.lisp), which src/surface.ts holds
;;;;   {"op":"surface"} -> {"ok":true,"surface":{command, tools:[...], commands:[...], dataEntryTypes:[...]}}
;;;;
;;;; tool, command, session-start, message-end, context: the host's calls and events
;;;; (src/register.ts), each answered with what to do (surface.lisp: EFFECTS, done in order)
;;;;   {"op":"tool","host":SNAPSHOT,"name":TOOL,"params":P,"projectFiles":[F...]} -> {"ok":true,"text":T,"effects":[...]}
;;;;   {"op":"command","host":SNAPSHOT,"suffix":"recall"|"pin"|"unpin"|"evict","args":TEXT,"projectFiles":[F...]}
;;;;   {"op":"session-start","host":SNAPSHOT,"projectFiles":[F...]} (the last session's named notes carried)
;;;;   {"op":"message-end","host":SNAPSHOT,"message":M} (a limit an error states, or the prompt accepted, learned)
;;;;   {"op":"context","host":SNAPSHOT,"messages":[M...],"tool":B (keel_context is registered)}
;;;;   -> also "messages": the request to send instead, or null to send it as it is
;;;;   (projectFiles: the project's other session files, newest first, which only the host orders to the millisecond)
;;;;
;;;; raw-capture: copy what omp may rewrite (src/raw-capture.ts)
;;;;   {"op":"raw-capture","input":{file, entries:[the message entries since the last call],
;;;;    kept:[ids of them the binding keeps], lineage:B}}
;;;;   -> {"ok":true,"written":[ID...],"stored":B,"lineage":[ID...]?}; the core appends
;;;;   <file>.keel-raw itself (STORED false: the write failed), and with LINEAGE
;;;;   reads the ids the file's and its parents' stores hold.
;;;;
;;;; placeholders: pointers on omp's placeholders (src/raw-capture.ts)
;;;;   {"op":"placeholders","host":SNAPSHOT,"candidates":[{i, callId, text}...],"kept":[ID...]}
;;;;   -> {"ok":true,"replace":[{i, text}...]}
;;;;
;;;; args: /keel's text and the instructions the hook reads (src/compaction.ts)
;;;;   {"op":"args","command":TEXT} -> {"ok":true,"followUpPrompt":P,"instructions":I} (keep:N in I)
;;;;   {"op":"args","instructions":TEXT|null} -> {"ok":true,"fromCommand":B,"keepUserTurns":N|null,"followUpPrompt":P|null}
;;;;
;;;; limits: the learned-limits file alone (limits.lisp), for its tests
;;;;   {"op":"limits","action":"window","model":M,"hostName":H,"dir":D} -> {"ok":true,"window":{host?,learned?,effective?,source}}
;;;;   (each action takes the model M, or KEY, its provider/id)
;;;;   {"op":"limits","action":"learn","model":M,"dir":D,"window":N,"now":ISO?} -> {"ok":true,"recorded":B}
;;;;   {"op":"limits","action":"learned","model":M,"dir":D} -> {"ok":true,"window":N?}
;;;;
;;;; settled: a run that settled (src/compaction.ts)
;;;;   {"op":"settled","host":SNAPSHOT} -> {"ok":true,"settled":{trigger, notice}?}
;;;;
;;;; outcome: what a compaction's outcome is told as (outcome.lisp; src/compaction.ts)
;;;;   {"op":"outcome","stats":S} -> {"ok":true,"line":L}
;;;;   {"op":"outcome","host":SNAPSHOT,"error":{message, mode, cancelNotice}} -> {"ok":true,"text":T?,"severity":S?}
;;;;   {"op":"outcome","details":D} -> {"ok":true,"own":DETAILS?}
;;;;   {"op":"outcome","settings":S,"provider":P} -> {"ok":true,"handles":B}
;;;;
;;;; window: the window rules (tests/support/window.ts), case by case
;;;;   {"op":"window","cases":[{"error":TEXT} | {ruleName, window, hostSettings|policy,
;;;;    recovering, tokensBefore, overheadTokens, workingSet}...]}
;;;;   -> {"ok":true,"results":[{"limit":N?} | {policy?, trigger?, autoCompacts, budgets}...]}
;;;;
;;;; Any error is answered {"ok":false,"error":MESSAGE}, never thrown past MAIN:
;;;; src/core.ts throws it as the core's failure, with the message.

(in-package #:keel)

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
                  collect (list* index (append (render-entry message) (list (search-text message) id message)))))))))

(defun handle-search (request)
  "Recall's search, as a keel_recall query runs it, over one session file's entries."
  (let ((floor (json-get request "floor")) (cap (json-get request "cap"))
        (loaded (view-load (open-view (json-get request "file") "all" nil) nil)))
    (multiple-value-bind (hits total truncated)
        (search-loaded loaded (let ((q (json-get request "query"))) (if (stringp q) q ""))
                       :floor (if (realp floor) (coerce floor 'double-float) +relative-floor+)
                       :cap (if (integerp cap) cap +result-cap+))
      (if (eq hits :aborted)
          (json-object "ok" :true "hits" #() "aborted" total)
          (json-object "ok" :true
                       "hits" (map 'vector (lambda (h) (json-object "index" (getf h :index) "role" (getf h :role) "summary" (getf h :summary)
                                                                    "files" (and (getf h :files) (coerce (getf h :files) 'vector))
                                                                    "snippet" (or (getf h :snippet) :null)))
                                   hits)
                       "totalBeforeCap" total
                       "truncated" (bool truncated))))))

(defun handle-load (request)
  "A source's entries as recall renders them and search reads them (tests/session-read.test.ts)."
  (json-object "ok" :true
               "entries" (map 'vector (lambda (e)
                                        (destructuring-bind (index role summary files text id message) e
                                          (json-object "index" index "id" id "role" role "summary" summary
                                                       "files" (and files (coerce files 'vector)) "text" text
                                                       ;; The message as the core reads it: what omp rewrote, with its kept original back.
                                                       "message" message)))
                              (source-entries (json-get request "source")))))

(defun regex-answer (pattern texts)
  "PATTERN compiled as `new RegExp(P, \"i\")` and run on TEXTS: what the regex
parity test compares with JavaScript's own."
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
    (regex-unsupported () (json-object "ok" :true "status" "unsupported"))))

(defun handle-regex (request)
  "One pattern, or every case in REQUEST's `cases` answered in one call: a
parity test runs thousands of them, and a process per pattern is what that
costs where there is no live core."
  (let ((cases (json-get request "cases")))
    (if (json-array-p cases)
        (json-object "ok" :true
                     "cases" (map 'vector (lambda (c) (regex-answer (json-get c "pattern") (json-get c "texts" #())))
                                  cases))
        (regex-answer (json-get request "pattern") (json-get request "texts" #())))))

(defun handle-summarize (request)
  "The summary of the CompileInput REQUEST carries in \"input\" (tests/support/compile.ts)."
  (multiple-value-bind (text state sections) (compile-summary (summary-input-from-json (json-get request "input")))
    (json-object "ok" :true "text" text "state" (state-json state) "sections" (coerce sections 'vector))))

(defun with-ok (reply) (setf (gethash "ok" reply) :true) reply)

(defun handle-compact (request)
  "A session_before_compact for the host REQUEST's snapshot names (host.lisp compact-for-host)."
  (with-ok (compact-for-host (read-snapshot (json-get request "host")) (json-get request "event") (json-get request "converted"))))

(defun cut-json (cut)
  "A cut as the cut op answers it: its messages, their ids, the first kept entry, and how it was made."
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
  "One of the cut's steps on REQUEST's branch, as the context holds it; like op
compact, it first asks for what the host's convertToLlm makes of the messages."
  (let ((branch (projected-branch request)))
    (multiple-value-bind (live originals) (host-messages branch nil)
      (let ((wanted (messages-to-convert live originals)) (converted (json-get request "converted")))
        (when (and wanted (not (json-array-p converted)))
          (return-from handle-cut (json-object "ok" :true "kind" "convert" "messages" (coerce wanted 'vector))))
        (let ((notes (host-notes branch live originals (or converted #()) (make-hash-table :test 'equal)))
              (action (json-get request "action"))
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
                   (json-object "ok" :true "keep" keep "adjusted" (bool adjusted))))
                (t (json-object "ok" :false "error" "cut: unknown action"))))))))

(defun handle-working-set (request)
  "The items [Working Set] picks of REQUEST's history, and the section's lines."
  (let* ((max (json-get request "maxChars"))
         ;; What the agent recalled lately, newest first (feedback.lisp), as a compaction reads it from the session.
         (items (select-working-set (coerce (json-get request "history" #()) 'list) (coerce (json-get request "indices" #()) 'list)
                                    (coerce (json-get request "kept" #()) 'list) max (recalled-of request))))
    (multiple-value-bind (lines shown) (format-working-set items max)
      (json-object "ok" :true
                   "items" (map 'vector (lambda (i) (json-object "index" (ws-item-index i) "title" (ws-item-title i)
                                                                 "note" (ws-item-note i) "text" (ws-item-text i)))
                                items)
                   "lines" (coerce lines 'vector) "shown" (coerce shown 'vector)))))

(defun action-json (action)
  "A request's action as JSON, for the request op's tests."
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

(defun handle-raw-capture (request)
  "Copy the entries REQUEST carries that omp may rewrite into the store (raw-capture.lisp)."
  (multiple-value-bind (written stored lineage) (capture-entries (json-get request "input"))
    (json-object "ok" :true "written" (coerce written 'vector) "stored" (if stored :true :false)
                 "lineage" (and lineage (coerce lineage 'vector)))))

(defun handle-placeholders (request)
  (json-object "ok" :true "replace"
               (coerce (point-placeholders (placeholders-input (read-snapshot (json-get request "host"))
                                                               (json-get request "candidates" #()) (json-get request "kept" #())))
                       'vector)))

(defun handle-limits (request)
  "The learned-limits file read and written alone (for its tests): by a model, or its provider/id key."
  (let* ((action (json-get request "action")) (model (json-get request "model")) (dir (json-get request "dir"))
         (key (let ((k (json-get request "key"))) (if (stringp k) k (model-key model)))))
    (unless (stringp dir) (return-from handle-limits (json-object "ok" :false "error" "limits: no dir")))
    (cond ((equal action "window") (json-object "ok" :true "window" (window-of model (json-get request "hostName") dir)))
          ((equal action "learn")
           (json-object "ok" :true "recorded"
                        (bool (record-learned-window dir key (json-get request "window")
                                                     (let ((now (json-get request "now"))) (if (stringp now) now (iso-now)))))))
          ((equal action "learned") (json-object "ok" :true "window" (learned-window dir key)))
          (t (json-object "ok" :false "error" "limits: unknown action")))))

(defun handle-settled (request)
  "A run that settled: whether keel compacts in the host's stead, and the note that says so."
  (json-object "ok" :true "settled" (settled-check (read-snapshot (json-get request "host")))))

(defun handle-outcome (request)
  (cond ((nth-value 1 (gethash "stats" request)) (json-object "ok" :true "line" (format-compaction-stats (json-get request "stats"))))
        ((nth-value 1 (gethash "error" request))
         (multiple-value-bind (text severity)
             (compact-error-feedback (compact-error-input (read-snapshot (json-get request "host")) (json-get request "error")))
           (json-object "ok" :true "text" text "severity" severity)))
        ((nth-value 1 (gethash "details" request)) (json-object "ok" :true "own" (keel-details-of (json-get request "details"))))
        (t (json-object "ok" :true "handles" (bool (handles-host-compactions-p (json-get request "settings") (json-get request "provider")))))))

(defun handle-window (request)
  "The window rules on each of REQUEST's cases (window.lisp window-case)."
  (json-object "ok" :true "results" (map 'vector #'window-case (json-get request "cases" #()))))

(defun handle-request (request)
  "The response object to the parsed REQUEST."
  (let ((op (json-get request "op")))
    (cond ((equal op "search") (handle-search request))
          ((equal op "load") (handle-load request))
          ((equal op "regex") (handle-regex request))
          ((equal op "summarize") (handle-summarize request))
          ((equal op "compact") (handle-compact request))
          ((equal op "cut") (handle-cut request))
          ((equal op "names") (json-object "ok" :true "names" (names-json)))
          ((equal op "request") (handle-request-parse request))
          ((equal op "working-set") (handle-working-set request))
          ((equal op "surface") (json-object "ok" :true "surface" (surface-json)))
          ((equal op "tool") (handle-tool request))
          ((equal op "command") (handle-command request))
          ((equal op "session-start") (handle-session-start request))
          ((equal op "message-end") (handle-message-end request))
          ((equal op "window") (handle-window request))
          ((equal op "settings") (handle-settings request))
          ((equal op "context") (handle-request-context request))
          ((equal op "raw-capture") (handle-raw-capture request))
          ((equal op "args") (handle-args request))
          ((equal op "limits") (handle-limits request))
          ((equal op "settled") (handle-settled request))
          ((equal op "outcome") (handle-outcome request))
          ((equal op "placeholders") (handle-placeholders request))
          ((equal op "context-edits") (handle-context-edits request))
          (t (json-object "ok" :false "error" (format nil "unknown op ~a" (json-string (or op :null))))))))

(defun read-stdin ()
  "Everything on stdin, decoded from UTF-8. Read as bytes and decoded at once:
a character stream decodes one character at a time, ten times slower on a
large request. *standard-input* rather than a fresh fd-stream on descriptor 0:
on Windows SBCL's fd-stream on that descriptor fails with `Access is denied`
when stdin is a pipe, which is how every host runs the core."
  (let ((in *standard-input*) (chunks '()) (total 0))
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
  "Entry point of the dumped executable: one request on stdin, or with --serve DIR
requests one after another (live.lisp)."
  (let ((args (rest sb-ext:*posix-argv*)))
    (when (equal (first args) "--serve")
      (handler-case (serve (second args)) (serious-condition () nil))
      (sb-ext:exit :code 0 :abort t)))
  (let ((response (handler-case
                      (handle-request (parse-json (read-stdin)))
                    ;; The heap or the stack running out too: the caller says the core failed.
                    (serious-condition (e) (json-object "ok" :false "error" (princ-to-string e))))))
    (write-json response *standard-output*)
    (terpri *standard-output*)
    (finish-output *standard-output*)
    (sb-ext:exit :code 0 :abort t)))
