;;;; names.lisp --- keel's own names, and the limits its tools' descriptions state.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; What keel registers with a host and writes into sessions, and the
;;;; numbers an agent is told (page sizes, the cap, the shortest session id).
;;;; surface.lisp words the tools and commands from them; op names hands them
;;;; over to the tests.

(in-package #:keel)

;;; The command prefix, /keel… on both hosts (each also registered under its old name).
(defparameter +command+ "keel")

;;; The tools and their params.
(defparameter +recall-tool+ "keel_recall")
(defparameter +recall-params+ '("query" "range" "expand" "page" "scope" "mode" "session"))
(defparameter +pin-tool+ "keel_pin")
(defparameter +pin-params+ '("note" "name" "unpin"))
(defparameter +context-tool+ "keel_context")
(defparameter +context-params+ '("drop" "oldest" "restore" "note" "undo" "force"))

;;; What keel writes into a session.
(defparameter +pin-entry-type+ "keel.pin" "Custom entries that hold a pin or unpin: in the session file, never in the context.")
(defparameter +recall-entry-type+ "keel.recall" "Custom entries that hold what one keel_recall call showed of this session (feedback.lisp): in the session file, never in the context.")
(defparameter +evict-entry-type+ "keel.evict" "Custom entries that take turns out of the context or bring them back: in the session file, never in the context.")
(defparameter +budget-notice-type+ "keel-budget" "The custom message telling the agent how full its context is; a summary leaves it out.")
(defparameter +resume-notice-type+ "keel-resume" "The custom message telling a new session where the project's last one stopped (resume.lisp); a summary's own [Task State] supersedes it.")
(defparameter +pin-notice-type+ "keel-pin" "The custom message telling the agent of a pin the user made; [Pinned Notes] carries the note, so a summary leaves it out.")
(defparameter +recall-command-message-type+ "keel-recall" "The custom message carrying /…-recall output to the agent.")
(defparameter +compactor+ "keel" "The compactor id in a compaction's details.")
(defparameter +legacy-compactors+ '("omp-vcc" "pi-vcc") "The compactor ids keel wrote under its earlier names, read as its own.")
(defparameter +compact-instruction+ "__keel__"
  "What /keel puts first in the customInstructions it hands the host, so the hook knows the pass is its own.")
(defparameter +raw-store-suffix+ ".keel-raw" "The originals of what omp rewrites in <session>.jsonl, kept beside it.")

;;; What keel wrote into sessions as omp-vcc, read as its own.
(defparameter +legacy-pin-entry-type+ "omp-vcc.pin")
(defparameter +legacy-evict-entry-type+ "omp-vcc.evict")
(defparameter +legacy-notice-types+ '("omp-vcc-pin" "omp-vcc-budget"))
(defparameter +legacy-raw-store-suffix+ ".vcc-raw")

(defun pin-entry-type-p (type) (member type (list +pin-entry-type+ +legacy-pin-entry-type+) :test #'equal))
(defun evict-entry-type-p (type) (member type (list +evict-entry-type+ +legacy-evict-entry-type+) :test #'equal))
(defun recall-entry-type-p (type) (equal type +recall-entry-type+))
(defun notice-type-p (type)
  "Whether TYPE is a notice keel sent the agent: a summary leaves those out."
  (member type (list* +pin-notice-type+ +resume-notice-type+ +budget-notice-type+ +legacy-notice-types+) :test #'equal))

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
(defparameter +context-note-chars+ 300 "A keel_context note is clipped to this many characters.")
(defparameter +evict-at-percent+ 85 "Past this percent of where the host compacts, the oldest finished turns leave the context (evict.lisp).")
(defparameter +session-ref-min-chars+ 4 "The shortest id prefix session:'id' takes.")

(defun names-json ()
  "The names and limits tests write into sessions, instructions and expectations, as op names hands them over."
  (json-object "pinEntryType" +pin-entry-type+ "evictEntryType" +evict-entry-type+ "recallEntryType" +recall-entry-type+
               "pinNoticeType" +pin-notice-type+ "resumeNoticeType" +resume-notice-type+ "rawStoreSuffix" +raw-store-suffix+
               "compactInstruction" +compact-instruction+ "pinChars" +pin-chars+ "recallOutputChars" +recall-output-chars+))
