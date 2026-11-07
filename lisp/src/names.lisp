;;;; names.lisp --- omp-vcc's own names, and the limits its tools' descriptions state.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; What omp-vcc registers with a host and writes into sessions, and the
;;;; numbers an agent is told (page sizes, the cap, the shortest session id).
;;;; The TypeScript side registers the tools with their descriptions before a
;;;; core may exist (it is built in the background), so it keeps its own copy
;;;; (src/names.ts, the tools); op names hands these over, and
;;;; tests/names.test.ts holds the copy to them.

(in-package #:omp-vcc)

;;; The tools and their params.
(defparameter +recall-tool+ "vcc_recall")
(defparameter +recall-params+ '("query" "range" "expand" "page" "scope" "mode" "session"))
(defparameter +pin-tool+ "vcc_pin")
(defparameter +pin-params+ '("note" "name" "unpin"))
(defparameter +context-tool+ "vcc_context")
(defparameter +context-params+ '("drop" "oldest" "restore" "note" "undo" "force"))

;;; What omp-vcc writes into a session.
(defparameter +pin-entry-type+ "omp-vcc.pin" "Custom entries that hold a pin or unpin: in the session file, never in the context.")
(defparameter +evict-entry-type+ "omp-vcc.evict" "Custom entries that take turns out of the context or bring them back: in the session file, never in the context.")
(defparameter +budget-notice-type+ "omp-vcc-budget" "The custom message telling the agent how full its context is; a summary leaves it out.")
(defparameter +pin-notice-type+ "omp-vcc-pin" "The custom message telling the agent of a pin the user made; [Pinned Notes] carries the note, so a summary leaves it out.")
(defparameter +recall-command-message-type+ "vcc-recall" "The custom message carrying /…-recall output to the agent.")
(defparameter +compactor+ "omp-vcc" "The compactor id in a compaction's details.")
(defparameter +legacy-compactor+ "pi-vcc" "pi-vcc's compactor id, read as omp-vcc's own.")
(defparameter +compact-instruction+ "__omp_vcc__"
  "What /omp-vcc puts first in the customInstructions it hands the host, so the hook knows the pass is its own.")
(defparameter +raw-store-suffix+ ".vcc-raw" "The originals of what omp rewrites in <session>.jsonl, kept beside it.")

;;; What the hosts write.
(defparameter +reset-entry-type+ "reset_boundary" "omp's /clear: what is before it on the branch has left the context.")
(defparameter +context-edit-type+ "context_edit" "Pi's edit of what one earlier entry contributes to the context.")

(defun recall-expand-call (n)
  "The call that shows entry #N in full, as the summary and omp's placeholders point at it."
  (format nil "~a expand:[~a]" +recall-tool+ n))

;;; The limits the tools' descriptions state.
(defparameter +search-page-size+ 5 "Hits on one page of a search.")
(defparameter +range-page-size+ 20 "Entries on one page of a range.")
(defparameter +recall-output-chars+ (* 50 1024) "One recall result's ceiling, 50 KB like a read tool's; less on a small window (recall-output-chars).")
(defparameter +pin-chars+ 300 "A pinned note is clipped to this many characters.")
(defparameter +pin-name-chars+ 40 "A pinned note's name is at most this many characters.")
(defparameter +context-note-chars+ 300 "A vcc_context note is clipped to this many characters.")
(defparameter +evict-at-percent+ 85 "Past this percent of where the host compacts, the oldest finished turns leave the context (evict.lisp).")
(defparameter +session-ref-min-chars+ 4 "The shortest id prefix session:'id' takes.")

(defun names-json ()
  "Every name and limit above, as op names hands them over."
  (json-object "recallTool" +recall-tool+ "recallParams" (coerce +recall-params+ 'vector)
               "pinTool" +pin-tool+ "pinParams" (coerce +pin-params+ 'vector)
               "contextTool" +context-tool+ "contextParams" (coerce +context-params+ 'vector)
               "pinEntryType" +pin-entry-type+ "evictEntryType" +evict-entry-type+ "pinNoticeType" +pin-notice-type+ "budgetNoticeType" +budget-notice-type+
               "recallCommandMessageType" +recall-command-message-type+
               "compactor" +compactor+ "legacyCompactor" +legacy-compactor+
               "compactInstruction" +compact-instruction+
               "searchPageSize" +search-page-size+ "rangePageSize" +range-page-size+
               "recallOutputChars" +recall-output-chars+ "pinChars" +pin-chars+ "pinNameChars" +pin-name-chars+ "evictAtPercent" +evict-at-percent+ "contextNoteChars" +context-note-chars+
               "sessionRefMinChars" +session-ref-min-chars+))
