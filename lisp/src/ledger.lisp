;;;; ledger.lisp --- what keel records in the session, and the turns it counts in.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; keel's records are custom entries in the session file, never in the context
;;;; and not counted in #N: keel.evict (a context edit: evict, restore, insert),
;;;; keel.recall (what a keel_recall call showed) and keel.pin (a note pinned or
;;;; unpinned). Each is replayed along the branch since its last /clear, so a
;;;; branch keeps its own and an edited turn drops the ones made after it. The
;;;; unit edits count in is the turn: a request the user made and every call and
;;;; result after it. Everything reads them here; evict.lisp, mirror.lisp, the
;;;; surface and pins.lisp decide what is recorded.

(in-package #:keel)

;;; A turn, as BRANCH-TURNS counts them.
(defstruct (turn (:constructor make-turn (from to))) "A turn's first and last #N." from to)

;;; A run of #N out of the context, as READ-EVICTIONS replays it.
(defstruct (out (:constructor make-out (from to by note at &optional text)))
  "A run of #N out of the context: FROM to TO inclusive, by \"agent\", \"user\" or
\"auto\", the agent's NOTE, AT the #N count when it was recorded (requests
made after that left it out), and TEXT, what the agent rewrote it as in its
context's file (mirror.lisp), which stands in its place instead of the line."
  from to by note at text)

;;; --- the ledger -------------------------------------------------------------------

(defun evict-entry-p (e)
  (and (equal (json-get e "type") "custom") (evict-entry-type-p (json-get e "customType"))
       (json-object-p (json-get e "data"))))

(defun op-at (op) (let ((at (json-get op "at"))) (if (js-integer-p at) (as-integer at) 0)))

(defun overlaps-p (from to other-from other-to) (and (<= from other-to) (>= to other-from)))

(defun range-text (from to) (if (= from to) (format nil "#~d" from) (format nil "#~d–#~d" from to)))

(defun read-evictions (branch &optional as-of)
  "What is out of the context on BRANCH since its last /clear: each evict and
restore replayed along it, as outs ordered by #N; with AS-OF, only the ops
recorded by then (when the #N count was at most AS-OF), as a request made then saw it."
  (let ((outs '()))
    (loop for i from (1+ (last-reset-index branch)) below (length branch)
          for e = (aref branch i)
          when (and (evict-entry-p e) (or (null as-of) (<= (op-at (json-get e "data")) as-of)))
            do (let* ((op (json-get e "data")) (from (json-get op "from")) (to (json-get op "to")))
                 (when (and (js-integer-p from) (js-integer-p to) (<= from to))
                   (let ((from (as-integer from)) (to (as-integer to)))
                     (cond ((equal (json-get op "op") "evict")
                            (push (make-out from to (let ((b (json-get op "by"))) (if (member b '("agent" "user" "auto") :test #'equal) b "agent"))
                                            (let ((n (json-get op "note"))) (and (stringp n) (plusp (length (js-trim n))) n))
                                            (op-at op)
                                            (let ((x (json-get op "text"))) (and (stringp x) (plusp (length (js-trim x))) x)))
                                  outs))
                           ((equal (json-get op "op") "restore")
                            (setf outs (remove-if (lambda (o) (overlaps-p (out-from o) (out-to o) from to)) outs))))))))
    (sort outs #'< :key #'out-from)))

(defun read-inserts (branch)
  "The agent's notes put after an entry in its context's file (mirror.lisp), by
#N: each insert replayed along BRANCH since its last /clear, the last one for
an #N standing, an empty one taking it away. An alist (N . TEXT)."
  (let ((at (make-hash-table)))
    (loop for i from (1+ (last-reset-index branch)) below (length branch)
          for e = (aref branch i)
          when (and (evict-entry-p e) (equal (json-get (json-get e "data") "op") "insert") (js-integer-p (json-get (json-get e "data") "after")))
            do (let ((text (json-get (json-get e "data") "text")) (n (as-integer (json-get (json-get e "data") "after"))))
                 (if (and (stringp text) (plusp (length (js-trim text)))) (setf (gethash n at) text) (remhash n at))))
    (sort (loop for n being the hash-keys of at using (hash-value text) collect (cons n text)) #'< :key #'car)))

(defun out-of (n outs) (find-if (lambda (o) (<= (out-from o) n (out-to o))) outs))

(defun evict-op (kind from to by at &optional note)
  (json-object "v" 1 "op" kind "from" from "to" to "by" by "at" at "note" note))

(defun recall-op (ns at) (json-object "v" 1 "ns" (coerce ns 'vector) "at" at))

(defun recall-entry-p (e)
  (and (equal (json-get e "type") "custom") (recall-entry-type-p (json-get e "customType"))
       (json-object-p (json-get e "data"))))

(defun read-recalls (branch)
  "Every #N the agent recalled on BRANCH since its last /clear, as (N . AT), AT the #N count then, oldest first."
  (loop for i from (1+ (last-reset-index branch)) below (length branch)
        for e = (aref branch i)
        when (recall-entry-p e)
          nconc (let ((at (op-at (json-get e "data"))) (ns (json-get (json-get e "data") "ns")))
                  (and (json-array-p ns)
                       (loop for n across ns when (js-integer-p n) collect (cons (as-integer n) at))))))

(defun out-periods (branch)
  "Each run of #N the ledger took out on BRANCH since its last /clear, as
(FROM TO START END): START the #N count it left at, END the one it came back at, NIL while it is out."
  (let ((periods '()))
    (loop for i from (1+ (last-reset-index branch)) below (length branch)
          for e = (aref branch i)
          when (evict-entry-p e)
            do (let* ((op (json-get e "data")) (from (json-get op "from")) (to (json-get op "to")))
                 (when (and (js-integer-p from) (js-integer-p to))
                   (let ((from (as-integer from)) (to (as-integer to)) (at (op-at op)))
                     (cond ((equal (json-get op "op") "evict") (push (list from to at nil) periods))
                           ((equal (json-get op "op") "restore")
                            (dolist (p periods)
                              (when (and (null (fourth p)) (overlaps-p (first p) (second p) from to)) (setf (fourth p) at)))))))))
    (nreverse periods)))

;;; --- turns --------------------------------------------------------------------------

(defun branch-turns (branch index)
  "The whole turns of BRANCH's live window by #N, oldest first: each starts at a
request the user made (not one another extension sent in the user's name, and
not a steer, which omp marks `steering: true` when the user writes while the
agent works: that is part of the running turn); what comes before the first
request in the window is a turn of its own. Pi marks no steer, so there one
starts a turn."
  (let ((turns '()))
    (loop for i from (live-window-start branch) below (length branch)
          for e = (aref branch i)
          for n = (and (counted-entry-p e) (gethash (json-get e "id") index))
          when n
            do (let ((m (json-get e "message")))
                 (if (or (null turns)
                         (and (equal (json-get m "role") "user") (not (extension-user-p m)) (not (eq (json-get m "steering") :true))))
                     (push (make-turn n n) turns)
                     (setf (turn-to (first turns)) n))))
    (nreverse turns)))

(defun turn-out-p (turn outs)
  "Whether all of TURN is out of the context (a turn whose older steps left while it ran is partly in)."
  (loop for n from (turn-from turn) to (turn-to turn) always (out-of n outs)))

(defun finished-turns (turns) "Every turn but the newest, which is the one running." (butlast turns))

(defun turns-in (turns outs) "The finished TURNS still in the context: what can leave." (remove-if (lambda (tr) (turn-out-p tr outs)) (finished-turns turns)))

(defun turn-steps (turn branch index)
  "TURN's steps by #N, as turns: its request (what comes before its first
assistant message), then each assistant message with the results and messages
after it, so a call never leaves without its result."
  (let ((steps '()))
    (loop for i from (live-window-start branch) below (length branch)
          for e = (aref branch i)
          for n = (and (counted-entry-p e) (gethash (json-get e "id") index))
          when (and n (<= (turn-from turn) n (turn-to turn)))
            do (if (or (null steps) (equal (json-get (json-get e "message") "role") "assistant"))
                   (push (make-turn n n) steps)
                   (setf (turn-to (first steps)) n)))
    (nreverse steps)))

(defun older-steps (turns branch index)
  "The steps of the running turn that can leave: all but its request, its newest
step, which the work in progress needs (nodecode evicts the same, after finished
turns), and any step holding a steer, the user's own words mid-run."
  (let ((running (car (last turns))))
    (when running
      (let ((user-ns (loop for i from (live-window-start branch) below (length branch)
                           for e = (aref branch i)
                           for n = (and (counted-entry-p e) (gethash (json-get e "id") index))
                           when (and n (equal (json-get (json-get e "message") "role") "user")) collect n)))
        (remove-if (lambda (st) (some (lambda (n) (<= (turn-from st) n (turn-to st))) user-ns))
                   (butlast (rest (turn-steps running branch index))))))))

(defun units-in (turns branch index outs)
  "What can leave the context, oldest first: the finished turns still in it, then the running turn's older steps."
  (append (turns-in turns outs) (remove-if (lambda (st) (out-of (turn-from st) outs)) (older-steps turns branch index))))

(defun room-to-evict-p (branch index)
  "Whether anything on BRANCH can still leave the context."
  (and (units-in (branch-turns branch index) branch index (read-evictions branch)) t))

(defun ranges-in (units outs)
  "The #N of UNITS still in the context, as (FROM . TO) ranges of consecutive #N:
what an eviction of them records, so a range never overlaps one already out."
  (let ((ranges '())
        (ns (sort (remove-duplicates (loop for u in units nconc (loop for n from (turn-from u) to (turn-to u) collect n))) #'<)))
    (dolist (n ns (nreverse ranges))
      (unless (out-of n outs)
        (if (and ranges (= n (1+ (cdr (first ranges))))) (setf (cdr (first ranges)) n) (push (cons n n) ranges))))))

(defun turn-chars (turn chars &optional outs)
  "The chars of TURN's messages (CHARS by #N), only those still in the context when OUTS is given."
  (loop for n from (turn-from turn) to (turn-to turn) unless (and outs (out-of n outs)) sum (gethash n chars 0)))

;;; --- pinned notes ---------------------------------------------------------------

(defun js-id (n)
  "An id as JavaScript holds it: an integer past 2^53 is the nearest double."
  (if (and (integerp n) (> (abs n) +double-exact+)) (coerce n 'double-float) n))

(defun pin-name (n) (let ((name (json-get n "name"))) (and (stringp name) name)))

(defun pin-name-of (value)
  "A note's name as given: trimmed and lowercased, letters, digits and . _ - only,
starting with a letter or digit, up to +PIN-NAME-CHARS+; NIL for anything else."
  (when (stringp value)
    (let ((name (string-downcase (js-trim value))))
      (and (<= 1 (length name) +pin-name-chars+)
           (rx-test (rx "^[a-z0-9][a-z0-9._-]*$") name)
           name))))

(defun format-pin (n)
  "A note as it is shown, in a listing and in [Pinned Notes]: [ID] NAME: TEXT (BY, #AT), NAME only for a named one."
  (let ((at (let ((a (json-get n "at"))) (and (not (eq a :null)) a))))
    (format nil "[~a] ~@[~a: ~]~a (~a~a)" (js-string-of (js-id (json-get n "id"))) (pin-name n) (json-get n "text") (json-get n "by")
            (cond (at (format nil ", #~a" (js-string-of (js-id at))))
                  ((stringp (json-get n "from")) (format nil ", from session ~a" (json-get n "from")))
                  (t "")))))

(defun pin-entry-p (e)
  "A pin or unpin entry: keel's custom entry, its data an object (an array is one to JavaScript too)."
  (and (equal (json-get e "type") "custom") (pin-entry-type-p (json-get e "customType"))
       (let ((d (json-get e "data"))) (or (json-object-p d) (json-array-p d)))))

(defun read-pins (branch)
  "The notes pinned on BRANCH since its last /clear, oldest first, as JSON: each
pin and unpin replayed along it, so a branch keeps the pins made on it."
  (let ((notes (make-hash-table)))
    (loop for i from (1+ (last-reset-index branch)) below (length branch)
          for e = (aref branch i)
          do (let ((op (json-get e "data")))
               (when (and (pin-entry-p e) (json-object-p op) (js-integer-p (json-get op "id")))
                 (let ((id (as-integer (json-get op "id"))) (text (json-get op "text")))
                   (cond ((and (equal (json-get op "op") "add") (stringp text) (plusp (length (js-trim text))))
                          (let ((name (pin-name-of (json-get op "name"))))
                            ;; A name defined again replaces the note it named.
                            (when name
                              (loop for k being the hash-keys of notes using (hash-value n)
                                    when (equal (pin-name n) name) do (remhash k notes)))
                            (setf (gethash id notes)
                                  (let ((note (json-object "id" id "text" text "by" (if (equal (json-get op "by") "agent") "agent" "user")
                                                           "at" (and (js-integer-p (json-get op "at")) (as-integer (json-get op "at"))))))
                                    (when name (setf (gethash "name" note) name))
                                    (when (stringp (json-get op "from")) (setf (gethash "from" note) (json-get op "from")))
                                    note))))
                         ((equal (json-get op "op") "remove") (remhash id notes)))))))
    (let ((ids (sort (loop for k being the hash-keys of notes collect k) #'<)))
      (mapcar (lambda (id) (gethash id notes)) ids))))
