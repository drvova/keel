;;;; mirror.lisp --- the context as a file the agent edits.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Context Language Models (arXiv 2609.37725) mirrors the model's live context
;;;; as a file whose path the model is given; the model edits it with the tools
;;;; it has, and what the file says is what the next request sends. This is that
;;;; design on keel's ledger: with eviction on, every request is written to
;;;; `<session>.jsonl.keel-context.md`, one block per turn under a marker line
;;;; (`[[CTX_TURN #12–#19]]`), the turns out of context as theirs
;;;; (`[[CTX_OUT …]]`), the agent's own notes as theirs (`[[CTX_NOTE after #N]]`).
;;;; Before the next request the file is read back and compared with what was
;;;; written (kept beside it, `.keel-context.last`):
;;;;
;;;; - a turn's block deleted: the turn leaves the context (an evict op);
;;;; - a turn's text changed: what the agent wrote stands in its place (an evict
;;;;   op with the text, out-text in evict.lisp), as does the text it writes
;;;;   where it deleted turns, and a changed `[[CTX_OUT]]` block;
;;;; - text of its own between turns it kept: a note after the turn before it
;;;;   (an insert op), as the paper's model makes a `role=notes` turn;
;;;; - the running turn's block is as it is: a call never leaves without its result.
;;;;
;;;; Nothing is lost by an edit: the ops go in the ledger, the session file keeps
;;;; every word, and keel_recall expand reads any original back; /…-evict undo and
;;;; keel_context undo reverse the last one.

(in-package #:keel)

(defparameter +mirror-suffix+ ".keel-context.md")
(defparameter +mirror-last-suffix+ ".keel-context.last")

(defun mirror-path (session-file) (concatenate 'string session-file +mirror-suffix+))

(defun mirror-header (path)
  "The line that tells the agent where its context's file is: the first in every
request (with the pinned notes), the same on each."
  (format nil "[Your context is mirrored in ~a, block by block as this request sends it. Edit that file to change what you hold: delete a [[CTX_TURN]] block to take its turn out, replace its text with what to keep of it, or write notes of your own between blocks. The next request sends what the file says. The session keeps every word (keel_recall expand:[N] reads any original back); the running turn stays as it is.]"
          path))

(defun mirror-marker (kind from to &optional running)
  "A block's marker line. The running turn's names only where it starts: it grows
with every request, and its line must hold still while the agent edits the file."
  (if running
      (format nil "[[CTX_~a #~d running, stays as it is]]" kind from)
      (format nil "[[CTX_~a ~a]]" kind (range-text from to))))

(defun message-mirror-text (m n)
  "A message as the file shows it: its role and #N, and its full text as recall's expand reads it."
  (destructuring-bind (role summary files) (render-entry m t n 1000000)
    (declare (ignore files))
    (format nil "[~a~@[ #~d~]] ~a" role n summary)))

(defun render-mirror (messages plan inserts)
  "The file for this request (PLAN, evict.lisp): a block for each turn in it, each
run of what is out and each of the agent's notes, in request order."
  (let* ((n-of (plan-n-of plan)) (dropped (plan-sent-as plan)) (outs (plan-outs plan)) (turns (plan-turns plan))
         (out (make-string-output-stream)) (current nil) (running (car (last turns))))
    (flet ((open-block (marker) (setf current marker) (format out "~%~a~%" marker)))
      (loop for i from 0 below (length messages)
            for m = (aref messages i)
            for n = (aref n-of i)
            do (cond ((eq (aref dropped i) t)
                      (let ((o (and n (out-of n outs))))
                        (when (and o (not (equal current (list :out (out-from o)))))
                          (setf current (list :out (out-from o)))
                          (format out "~%~a~%~a~%" (mirror-marker "OUT" (out-from o) (out-to o))
                                  (or (out-text o)
                                      (format nil "(out of context: ~a reads it back)" (recall-expand-call (out-from o))))))))
                     (t
                      (let ((tr (and n (find-if (lambda (tr) (<= (turn-from tr) n (turn-to tr))) turns))))
                        (when (and tr (not (equal current (list :turn (turn-from tr)))))
                          (open-block (mirror-marker "TURN" (turn-from tr) (turn-to tr) (eq tr running)))
                          (when (eq tr running) (format out "(the turn running now: it stays as it is, and is not in this file, so the file holds still while you edit it)~%"))
                          (setf current (list :turn (turn-from tr))))
                        ;; The running turn's messages are left out: it grows with every request,
                        ;; and a file that changes under the agent's edit is an edit misread.
                        (unless (and tr (eq tr running))
                          (format out "~a~%" (if (stringp (aref dropped i))
                                                 (format nil "[toolResult #~d] ~a" n (aref dropped i))
                                                 (message-mirror-text m n))))
                        (let ((note (and n (cdr (assoc n inserts)))))
                          (when note
                            (format out "~%~a~%~a~%" (format nil "[[CTX_NOTE after #~d]]" n) note)
                            (setf current (list :note n)))))))))
    (get-output-stream-string out)))

;;; --- reading the file back ------------------------------------------------------------

(defstruct (mblock (:constructor make-mblock (marker kind from to running body)))
  marker kind from to running body)

(defun parse-marker (line)
  "A marker line's kind (:turn, :out, :note), range and running flag, or NIL for any other line."
  (let ((m (rx-exec (rx "^\\[\\[CTX_(TURN|OUT|NOTE) (?:after )?#(\\d+)(?:[–-]#(\\d+))?( running[^\\]]*)?\\]\\]\\s*$") line)))
    (when m
      (let ((from (parse-integer (rx-group m 2))))
        (list (intern (rx-group m 1) :keyword) from (if (rx-group m 3) (parse-integer (rx-group m 3)) from) (and (rx-group m 4) t))))))

(defun parse-mirror (text)
  "The file's blocks in order: each line starting `[[CTX_` opens one (an unknown one,
the agent's own, is kind NIL), its body the lines up to the next, trimmed."
  (let ((blocks '()) (marker nil) (body '()))
    (flet ((close-block ()
             (when marker
               (let ((parsed (parse-marker marker)))
                 (push (make-mblock marker (first parsed) (second parsed) (third parsed) (fourth parsed)
                                    (js-trim (join-strings (reverse body) (string #\Newline))))
                       blocks)))))
      (dolist (line (split-string text #\Newline))
        (if (and (>= (length line) 6) (string= "[[CTX_" line :end2 6))
            (progn (close-block) (setf marker (js-trim line) body '()))
            (when marker (push line body))))
      (close-block))
    (nreverse blocks)))

(defun same-text-p (a b)
  "A and B the same but for whitespace: an agent's script that rejoins lines or trims them has not rewritten anything."
  (string= (js-trim (rx-replace (rx "\\s+") a " " :all t)) (js-trim (rx-replace (rx "\\s+") b " " :all t))))

(defun mirror-ops (written edited branch index count)
  "What the agent's edit of its context's file did, as ledger ops, from WRITTEN
(the file as keel wrote it) and EDITED (as it is now): (values OPS IGNORED),
IGNORED the running turn's block when the agent changed it."
  (let* ((before (parse-mirror written)) (after (parse-mirror edited))
         (outs (read-evictions branch)) (turns (branch-turns branch index))
         (by-marker (make-hash-table :test 'equal))
         (extra (make-hash-table :test 'equal)) ; text of the agent's own, by the known marker before it
         (ops '()) (ignored nil))
    (let ((prev :start))
      (dolist (b after)
        (if (and (mblock-kind b) (find (mblock-marker b) before :key #'mblock-marker :test #'equal))
            (setf (gethash (mblock-marker b) by-marker) b prev (mblock-marker b))
            (let ((text (if (mblock-kind b) (mblock-body b) (js-trim (format nil "~a~%~a" (mblock-marker b) (mblock-body b))))))
              ;; The agent's own block: its marker is its own words, unless it is the paper's `role=notes` kind of header.
              (when (and (null (mblock-kind b)) (rx-test (rx "^\\[\\[CTX_[A-Z]+[^\\]]*\\]\\]$") (mblock-marker b)))
                (setf text (mblock-body b)))
              (when (plusp (length text))
                (setf (gethash prev extra) (let ((had (gethash prev extra))) (if had (format nil "~a~%~a" had text) text))))))))
    (labels ((text-at (marker) (gethash marker extra))
             (rewrite (from to text)
               ;; What is out there already comes back first, so the text stands for the whole span.
               (dolist (o outs)
                 (when (overlaps-p (out-from o) (out-to o) from to)
                   (push (evict-op "restore" (out-from o) (out-to o) "agent" count) ops)))
               (let ((op (evict-op "evict" from to "agent" count)))
                 (when (and text (plusp (length text))) (setf (gethash "text" op) text))
                 (push op ops)))
             (flush (removed marker)
               (let ((text (text-at marker)))
                 (cond (removed
                        (let ((ranges (ranges-in removed outs)))
                          (loop for r in ranges for first = t then nil
                                do (if first (rewrite (car r) (cdr r) text) (push (evict-op "evict" (car r) (cdr r) "agent" count) ops)))))
                       ((and text (gethash marker by-marker))
                        (let ((k (gethash marker by-marker)))
                          (push (json-object "v" 1 "op" "insert" "after" (mblock-to k) "text" text "by" "agent" "at" count) ops)))))))
      (let ((removed '()) (prev :start))
        (dolist (b before)
          (let ((now (gethash (mblock-marker b) by-marker)))
            (cond (now
                   (flush (nreverse removed) prev)
                   (setf removed '() prev (mblock-marker b))
                   (unless (same-text-p (mblock-body now) (mblock-body b))
                     (case (mblock-kind b)
                       (:turn (if (mblock-running b)
                                  (setf ignored t)
                                  (rewrite (mblock-from b) (mblock-to b) (mblock-body now))))
                       (:out (rewrite (mblock-from b) (mblock-to b) (mblock-body now)))
                       (:note (push (json-object "v" 1 "op" "insert" "after" (mblock-from b) "text" (mblock-body now) "by" "agent" "at" count) ops)))))
                  (t
                   (case (mblock-kind b)
                     (:turn (if (mblock-running b)
                                (setf ignored t)
                                (let ((tr (find (mblock-from b) turns :key #'turn-from)))
                                  (when tr (push tr removed)))))
                     (:note (push (json-object "v" 1 "op" "insert" "after" (mblock-from b) "text" "" "by" "agent" "at" count) ops))
                     ;; An [[CTX_OUT]] block deleted: it stays out, as it was.
                     (t nil))))))
        (flush (nreverse removed) prev)))
    (values (dedupe-ops (nreverse ops)) ignored)))

(defun dedupe-ops (ops)
  "OPS with each range restored once and evicted once (the last evict for it
standing, as the last edit of a block does) and each note once, in order:
an edit that names a block twice is one edit of it."
  (let ((seen (make-hash-table :test 'equal)) (kept '()))
    (dolist (op (reverse ops) kept)
      (let ((key (list (json-get op "op") (json-get op "from") (json-get op "to") (json-get op "after"))))
        (unless (gethash key seen)
          (setf (gethash key seen) t)
          (push op kept))))))

;;; --- files ---------------------------------------------------------------------------

(defun read-text-file (path)
  "PATH's text, or NIL when there is no such file."
  (let ((bytes (read-file-octets (native-path path)))) (and bytes (decode-utf-8 bytes))))

(defun mirror-edits (session-file branch index count)
  "The ops the agent's edit of its context's file makes, and whether it changed the
running turn: (values OPS IGNORED). Nothing when the file is as it was written."
  (let* ((path (mirror-path session-file))
         (written (read-text-file (concatenate 'string session-file +mirror-last-suffix+)))
         (edited (read-text-file path)))
    (if (and written edited (string/= written edited))
        (mirror-ops written edited branch index count)
        (values '() nil))))

(defun write-mirror (session-file text)
  "Write the file for this request, and the copy the next request compares the agent's edit with."
  (write-text-file (mirror-path session-file) text)
  (write-text-file (concatenate 'string session-file +mirror-last-suffix+) text))

(defun mirror-notice (ops ignored)
  "What the user is told of the agent's edit of its context's file."
  (let ((out (remove-if-not (lambda (op) (and (equal (json-get op "op") "evict") (not (stringp (json-get op "text"))))) ops))
        (rewritten (remove-if-not (lambda (op) (and (equal (json-get op "op") "evict") (stringp (json-get op "text")))) ops))
        (notes (remove-if-not (lambda (op) (equal (json-get op "op") "insert")) ops)))
    (format nil "keel: the agent edited its context's file:~@[ ~{~a~^, ~} out~]~@[;~*~]~@[ ~{~a~^, ~} rewritten~]~@[;~*~]~@[ ~d note~:p~]~:[~;; its edit of the running turn is left out~]."
            (and out (mapcar (lambda (op) (range-text (json-get op "from") (json-get op "to"))) out))
            (and out (or rewritten notes))
            (and rewritten (mapcar (lambda (op) (range-text (json-get op "from") (json-get op "to"))) rewritten))
            (and rewritten notes)
            (and notes (length notes))
            ignored)))
