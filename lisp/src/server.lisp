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
;;;; load: one source's entries as the core reads them, for the parity test
;;;;   {"op":"load","source":SOURCE} -> {"ok":true,"entries":[{"index","role","summary","files"?,"text"}...]}
;;;;
;;;; regex: one pattern as `new RegExp(P, "i")` on texts, for the parity test
;;;;   {"op":"regex","pattern":P,"texts":[T...]}
;;;;   -> {"ok":true,"status":"ok","results":[{"test":B,"search":I,"count":N}...]}
;;;;      or "status":"syntax" (JavaScript throws) or "unsupported" (left to TS)
;;;;
;;;; summarize: a compaction's summary (src/core/summarize.ts compileSummary)
;;;;   {"op":"summarize","input":COMPILE-INPUT} -> {"ok":true,"text":T,"state":STATE,"sections":[S...]}
;;;;   or {"ok":false,"unsupported":"summary"} for input left to TS (text in a
;;;;   script segmented by dictionary, a regex construct it refuses)
;;;;
;;;; compact: what a compaction does (src/compaction/plan.ts planCompaction)
;;;;   {"op":"compact","input":{branch, notes, keepUserTurns, fromCommand, reason,
;;;;    recovering, settings, budgets, charsPerToken, sessionFile, previousSummary, fileOps}}
;;;;   -> {"ok":true,"plan":PLAN}; NOTES, parallel to BRANCH, carry for each live
;;;;   message what the host's convertToLlm makes of it (summary-input.ts
;;;;   toSummaryMessage), as it is and as its kept original, and its #N.
;;;;
;;;; recall: one vcc_recall call or /…-recall command (src/core/recall-run.ts recall)
;;;;   {"op":"recall","input":{call:{surface:"tool",params}|{surface:"command",name,args},
;;;;    sessionFile, projectFiles (newest first), cwd, lineageIds, hostBranch, contextWindow, skipCurrentTurn}}
;;;;   -> {"ok":true,"recall":{"ok":B,"text":T,"severity":S?}}
;;;;
;;;; Either search may answer {"ok":false,"unsupported":"regex"}, and the caller
;;;; searches as before; {"ok":false,"error":MESSAGE} on any failure.
;;;;
;;;; Any error is answered, never thrown past MAIN: a caller that gets no
;;;; answer falls back, so a broken core costs speed, not recall.

(in-package #:omp-vcc)

(defun bool (x) (if x :true :false))

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
        ((eq hits :regex) (json-object "ok" :false "unsupported" "regex"))
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
               (allowed (cond ((and (vectorp ids) (not (stringp ids)))
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
          ((eq hits :regex) (json-object "ok" :false "unsupported" "regex"))
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
  "A source's entries as recall renders them and search reads them: what the
parity test compares with the TS side's load."
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
  (handler-case
      (multiple-value-bind (text state sections) (compile-summary (json-get request "input"))
        (json-object "ok" :true "text" text "state" (state-json state) "sections" (coerce sections 'vector)))
    ((or left-to-ts regex-unsupported storage-condition) () (json-object "ok" :false "unsupported" "summary"))))

(defun handle-compact (request)
  "planCompaction on the PlanInput REQUEST carries in \"input\", the host's convertToLlm already applied."
  (handler-case (json-object "ok" :true "plan" (plan-compaction (json-get request "input")))
    ((or left-to-ts regex-unsupported storage-condition) () (json-object "ok" :false "unsupported" "compact"))))

(defun handle-recall (request)
  "recall-run.ts recall() on the call REQUEST carries in \"input\"."
  (handler-case
      (multiple-value-bind (ok text severity) (run-recall (json-get request "input"))
        (json-object "ok" :true "recall" (json-object "ok" (if ok :true :false) "text" text "severity" severity)))
    ((or left-to-ts regex-unsupported storage-condition) () (json-object "ok" :false "unsupported" "recall"))))

(defun handle-request (request)
  "The response object to the parsed REQUEST."
  (let ((op (json-get request "op")))
    (cond ((equal op "search") (handle-search request))
          ((equal op "search-sessions") (handle-search-sessions request))
          ((equal op "load") (handle-load request))
          ((equal op "regex") (handle-regex request))
          ((equal op "summarize") (handle-summarize request))
          ((equal op "compact") (handle-compact request))
          ((equal op "recall") (handle-recall request))
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
                    (error (e) (json-object "ok" :false "error" (princ-to-string e))))))
    (write-json response *standard-output*)
    (terpri *standard-output*)
    (finish-output *standard-output*)
    (sb-ext:exit :code 0 :abort t)))
