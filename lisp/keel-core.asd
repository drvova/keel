;;;; keel-core.asd --- the Lisp core of keel.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The hosts (omp, Pi) load only JS/TS extensions, so index.ts and pi.ts stay
;;;; TypeScript and hand requests to this core: one JSON object on stdin, one
;;;; on stdout (src/server.lisp). Everything a request needs is computed here.
;;;;
;;;; No dependencies beyond SBCL itself. The core is dumped as one executable
;;;; (build.lisp) that links only libc and libm, and nothing a user installs
;;;; has to fetch a library: JSON (src/json.lisp) and the test runner
;;;; (test/support.lisp) are this system's own.
;;;;
;;;; Components are listed in load order and named one by one, so a file left
;;;; out fails the load instead of being skipped.

(defsystem "keel-core"
  :description "keel's core: everything keel decides (compaction, the summary, recall, pins, settings), run as one JSON request and response per process."
  :license "MIT"
  :version "0.1.0"
  :serial t
  :components
  ((:module "src"
    :serial t
    :components
    ((:file "package")
     ;; js-string precedes everything that measures or cuts text: budgets and
     ;; offsets are JavaScript's (UTF-16 code units), so the TS side and this
     ;; core agree on every number they exchange.
     (:file "js-string")
     (:file "json")
     ;; js: JavaScript's reading of JSON values (truthiness, arrays, empties), for every module.
     (:file "js")
     ;; names: keel's own names, and the limits its tools state.
     (:file "names")
     ;; regex: JavaScript's regular expressions, which search compiles a
     ;; query and its terms with.
     (:file "regex")
     ;; rx: the TS's own regexes as written, on that engine.
     (:file "rx")
     (:file "search")
     ;; session and render read a session file as recall does: the entries,
     ;; their #N, the branch, the kept originals, and each one rendered.
     (:file "session")
     (:file "render")
     ;; calls: tool calls and their results, read one way for every section.
     (:file "calls")
     ;; The summary pipeline: blocks,
     ;; the section extractors, the brief and its ranking, the summary itself.
     (:file "blocks")
     (:file "extract")
     (:file "brief")
     (:file "history")
     (:file "summary")
     ;; The compaction: its cut, the working set, and the plan the hook acts on.
     (:file "working-set")
     (:file "task-state")
     ;; context-edits: Pi's context edits, applied before the cut reads the branch.
     (:file "context-edits")
     (:file "compaction")
     ;; window: where the host compacts next, and the budgets below it.
     (:file "window")
     ;; settings and pins: the config file, and pinning and unpinning notes.
     (:file "settings")
     (:file "pins")
     ;; raw-capture: the originals of what omp rewrites, kept as they land.
     (:file "raw-capture")
     ;; args: what /keel hands the hook, and the hook reads back.
     (:file "args")
     ;; limits and outcome: a model's learned window, and what a compaction's outcome is told as.
     (:file "limits")
     (:file "outcome")
     ;; The rest of recall: the request, the project's sessions, the call.
     (:file "request")
     (:file "sessions")
     (:file "recall")
     ;; evict: old turns out of the context whole, and the request without them.
     (:file "evict")
     ;; mirror: the context as a file the agent edits (Context Language Models).
     (:file "mirror")
     ;; host: the snapshot of what the host knows, which every op for a host event reads.
     (:file "host")
     (:file "server")
     ;; live: the same requests one after another in one long-lived process.
     (:file "live"))))
  :in-order-to ((test-op (test-op "keel-core/test"))))

(defsystem "keel-core/test"
  :depends-on ("keel-core")
  :serial t
  :components
  ((:module "test"
    :serial t
    :components
    ((:file "support")
     (:file "js-string")
     (:file "json")
     (:file "search")
     (:file "estimate")
     (:file "tools")
     (:file "store")
     (:file "numbers"))))
  :perform (test-op (op c)
             (declare (ignore op c))
             (unless (uiop:symbol-call '#:keel.test '#:run-all)
               (error "keel-core tests failed"))))
