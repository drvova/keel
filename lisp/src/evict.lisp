;;;; evict.lisp --- whole turns out of the context, never rewritten, read back word for word.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The other way to make room: instead of a summary written over the oldest
;;;; part of the window, the oldest finished turns leave the context whole. The
;;;; session file keeps every word (keel_recall expand:[N] reads any of them back
;;;; exactly, and search finds them); only the requests the host sends change. In
;;;; their place the request carries one line per run of turns that are out,
;;;; naming their #N and how to read them back. Context Language Models
;;;; (arXiv:2609.37725) let the model decide what leaves and found summaries "can
;;;; lose or hallucinate information"; nodecode drops the oldest finished turns
;;;; whole past 85% of the window. Here the agent decides with keel_context, the
;;;; user with the evict command, and past +EVICT-AT-SHARE+ of the host's trigger
;;;; the oldest finished turns leave by themselves down to +EVICT-TO-SHARE+, so
;;;; the host's own compaction is rarely reached; when it is, the summary is the
;;;; safety net it always was.
;;;;
;;;; What is out is a ledger of keel custom entries (+evict-entry-type+),
;;;; replayed along the branch as pins are, so a branch keeps its own evictions
;;;; and an edited turn drops the ones made after it. A turn is the unit: it
;;;; starts at a request the user made and holds every call and result after it,
;;;; so a tool call never leaves without its result. The running turn never
;;;; leaves. Evictions drop far and rarely, from the oldest end, and the line in
;;;; their place is the same on every request: every edit makes the provider read
;;;; again all that follows it, so one large eviction costs less than many small
;;;; ones (the paper's harness tells its model the same).

(in-package #:keel)

(defparameter +evict-at-share+ (/ +evict-at-percent+ 100d0) "Past this share of the host's trigger, the oldest finished turns leave.")
(defparameter +evict-to-share+ 0.5d0 "They leave until the context is estimated at this share of the trigger.")
(defparameter +big-result-share+ 1/16 "A tool result this share of the trigger or more leaves on its own first, its call kept.")
(defparameter +big-result-min-tokens+ 2000 "And at least this many tokens: below it, a result leaves with its turn.")
(defstruct (payback (:constructor make-payback (share cache write ahead measured)))
  "When an eviction by the agent pays, worked out from the session: SHARE, how
much of what it makes the provider read again it must free; CACHE and WRITE, a
cached and a written token's price as a share of an input token's; AHEAD, the
requests it is counted over; MEASURED, whether the prices are the session's own."
  share cache write ahead measured)

(defparameter +payback-default-cache+ 0.1d0 "A cached token's price as a share of an input token's, before the session shows its own.")
(defparameter +payback-min-requests+ 3 "Requests a session must have made before its own prices and cache are believed.")
(defparameter +payback-ahead+ '(5 . 200) "The requests an eviction is counted over: as many as the session has made, within these.")

(defun eviction-payback (messages)
  "When an eviction pays, from MESSAGES (the session's): every edit makes the
provider read all that follows it again, uncached or written to the cache anew,
once (each such token at WRITE of an input token's price instead of CACHE);
what leaves then saves CACHE on every later request. Over AHEAD requests it
pays when FREED x CACHE x AHEAD >= READ-AGAIN x (WRITE - CACHE): SHARE is
(WRITE - CACHE) / (CACHE x AHEAD). The prices are the session's own (each
request's usage: tokens and their cost, as both hosts record them), the
requests ahead as many as it has made (a session that has run long tends to run
on); a provider that caches nothing has nothing to read again at a premium, so
any eviction pays. Before enough requests, a cache at a tenth of the price and
20 requests ahead, a share of 0.45."
  (let ((n 0) (input 0) (input-cost 0) (read 0) (read-cost 0) (write 0) (write-cost 0))
    (dolist (m messages)
      (let ((u (and (json-object-p m) (equal (json-get m "role") "assistant") (json-get m "usage"))))
        (when (and (json-object-p u) (usage-prompt-tokens m))
          (let ((cost (json-get u "cost")))
            (incf n)
            (incf input (number-or-zero (json-get u "input"))) (incf read (number-or-zero (json-get u "cacheRead")))
            (incf write (number-or-zero (json-get u "cacheWrite")))
            (when (json-object-p cost)
              (incf input-cost (number-or-zero (json-get cost "input"))) (incf read-cost (number-or-zero (json-get cost "cacheRead")))
              (incf write-cost (number-or-zero (json-get cost "cacheWrite"))))))))
    (let* ((measured (>= n +payback-min-requests+))
           (ahead (max (car +payback-ahead+) (min (cdr +payback-ahead+) (if measured n 20))))
           (input-price (and (plusp input) (plusp input-cost) (/ input-cost input))))
      (cond ((and measured (zerop read))
             (make-payback 0d0 1d0 1d0 ahead t))
            (t
             (let* ((cache (if (and measured input-price (plusp read) (plusp read-cost))
                               (min 1d0 (coerce (/ (/ read-cost read) input-price) 'double-float))
                               +payback-default-cache+))
                    (write-share (if (and measured input-price (plusp write) (plusp write-cost))
                                     (coerce (/ (/ write-cost write) input-price) 'double-float)
                                     1d0)))
               (make-payback (max 0d0 (/ (- write-share cache) (* cache ahead))) cache write-share ahead
                             (and measured input-price (plusp read-cost) t))))))))

(defun restore-pays-p (q payback before turn-tokens after-tokens)
  "Whether bringing back a turn of TURN-TOKENS, with AFTER-TOKENS in the context
after it and BEFORE tokens in all, costs less than the recalls it would still
take: Q / (1 - Q) of them, each a request with the context at the cache price
and the turn's text sent again; against reading AFTER-TOKENS again written to
the cache, the turn written once, and the turn carried on the requests ahead."
  (let* ((cache (payback-cache payback)) (write (payback-write payback)) (ahead (payback-ahead payback))
         (recalls (/ q (- 1 q)))
         (benefit (* recalls (+ (* before cache) turn-tokens)))
         (cost (+ (* after-tokens (max 0 (- write cache))) (* turn-tokens write) (* turn-tokens cache ahead))))
    (>= benefit cost)))

(defun payback-words (p)
  (if (zerop (payback-share p))
      "this provider has cached nothing this session, so nothing is read again at a premium"
      (format nil "~:[assuming a cache at ~d% of the input price~;at this session's prices, a cached token ~d% of an input token's~]~@[ and a cache write ~d%~], over ~d more requests"
              (payback-measured p) (round (* 100 (payback-cache p)))
              (and (/= (payback-write p) 1d0) (round (* 100 (payback-write p)))) (payback-ahead p))))
(defparameter +stub-requests-shown+ 3 "Requests a stub names of the turns it stands for.")
(defparameter +turns-listed+ 40 "Turns a listing shows, newest last.")
(defparameter +budget-note-from+ 5
  "From this tenth of the host's trigger on, the model is told how full its context
is and that keel_context makes room, once per tenth: the paper's harness and
pi-clm keep the model budget-aware, or it never edits. The note is a message of
its own, stored in the session, so the provider's cache keeps it, unlike a line
that would change at the end of every request.")

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

;;; --- sizes and the line left in their place -------------------------------------------

(defun turn-chars (turn chars &optional outs)
  "The chars of TURN's messages (CHARS by #N), only those still in the context when OUTS is given."
  (loop for n from (turn-from turn) to (turn-to turn) unless (and outs (out-of n outs)) sum (gethash n chars 0)))

(defun request-words (message)
  (let ((words (user-words (rx-replace (host-block-regex) (text-of (json-get message "content")) "" :all t))))
    (and (plusp (length words)) (js-clip words 60))))

(defun by-words (bys)
  (let ((names (mapcar (lambda (b) (cond ((equal b "user") "the user") ((equal b "auto") "keel as the context filled") (t "the agent")))
                       (remove-duplicates bys :test #'equal :from-end t))))
    (join-strings names " and ")))

(defun span-what (from to turns)
  "What the span FROM–TO holds, in words: its whole turns, and the older steps of a turn it cuts into."
  (let* ((whole (count-if (lambda (tr) (and (<= from (turn-from tr)) (<= (turn-to tr) to))) turns))
         (cut (find-if (lambda (tr) (and (overlaps-p from to (turn-from tr) (turn-to tr))
                                         (not (and (<= from (turn-from tr)) (<= (turn-to tr) to)))))
                       turns)))
    (join-strings (remove nil (list (and (plusp whole) (plural whole "turn"))
                                    (and cut (format nil "older steps of the turn at #~d" (turn-from cut)))))
                  " and ")))

(defun stub-text (from to turns outs messages-by-n originals)
  "The line the span FROM–TO of what is out leaves in the request: what it was,
what it did (as [History Index] says it: files changed, commits, failed calls,
read from the originals keel kept, ORIGINALS by #N), and how to read it back.
It names no size, and reads only what omp leaves as it is or the originals: the
line must read the same on every request for the provider's cache."
  (let ((covering (remove-if-not (lambda (o) (overlaps-p (out-from o) (out-to o) from to)) outs)))
    (if (some #'out-text covering)
        (rewrite-text from to covering)
        (plain-stub-text from to turns covering messages-by-n originals))))

(defun rewrite-text (from to covering)
  "What stands in place of FROM–TO when the agent rewrote some of it in its
context's file: its text, under a line saying what it stands for."
  (format nil "[~a, as you rewrote ~:[it~;them~] in your context's file (each original reads back word for word with ~a)]~{~%~a~}"
          (range-text from to) (> (length covering) 1) (recall-expand-call from)
          (mapcar (lambda (o) (or (out-text o) (format nil "(~a out of context)" (range-text (out-from o) (out-to o))))) covering)))

(defun plain-stub-text (from to turns covering messages-by-n originals)
  (let* ((requests (loop for n from from to to
                         for m = (gethash n messages-by-n)
                         for w = (and m (equal (json-get m "role") "user") (not (extension-user-p m)) (request-words m))
                         when w collect w))
         (shown (subseq requests 0 (min +stub-requests-shown+ (length requests))))
         (ns (loop for n from from to to when (gethash n originals) collect n))
         (range (and ns (range-of-window (map 'vector (lambda (n) (gethash n originals)) ns) (coerce ns 'vector))))
         (work (and range (range-work range)))
         (notes (remove nil (mapcar #'out-note covering))))
    (format nil "[~a out of context: ~a, by ~a.~@[ Requests: ~a.~]~@[ It ~a.~]~@[ The agent's note: ~a~] Each entry reads back word for word with ~a; keel_recall query searches them.]"
            (range-text from to) (span-what from to turns) (by-words (mapcar #'out-by covering))
            (and shown (format nil "~{\"~a\"~^; ~}~@[ (+~d more)~]" shown (and (> (length requests) (length shown)) (- (length requests) (length shown)))))
            (and work (join-strings work "; "))
            (and notes (join-strings (mapcar (lambda (n) (if (find (char n (1- (length n))) ".!?") n (concatenate 'string n "."))) notes) " "))
            (recall-expand-call from))))

(defun notes-as-of (branch index edited)
  "The pinned notes the block at the start of the request shows, and the #N they
are as of: as they read at the last edit of the context (the last evict or
restore on BRANCH; EDITED, one made for this request: all of BRANCH), and those
carried in before the first message. An edit at the start of the request makes
the provider read all of it again (Context Language Models measures 7.7 times
an appended turn's cost), so the block changes only when the context is being
edited anyway: a note pinned since stands in the conversation, in its keel_pin
call, until its turn leaves, which is an edit, and the block takes it up then.
(values NOTES AS-OF), AS-OF the #N of the last message before the cut, or NIL."
  (let* ((last-edit (loop for i from (1- (length branch)) downto 0
                          for e = (aref branch i)
                          when (and (evict-entry-p e) (member (json-get (json-get e "data") "op") '("evict" "restore") :test #'equal))
                            return i))
         (first-message (position-if #'counted-entry-p branch :start (live-window-start branch)))
         (cut (cond (edited (length branch)) (last-edit (1+ last-edit)) (first-message first-message) (t (length branch))))
         (last-message (position-if #'counted-entry-p branch :end cut :from-end t)))
    (values (read-pins (subseq branch 0 cut))
            (and last-message (gethash (json-get (aref branch last-message) "id") index)))))

(defun notes-block (pins as-of)
  "The pinned notes as of AS-OF, one block at the start of the request: the
context's notes, kept by the agent and the user (keel_pin, /…-pin), in view
whatever has left the context."
  (format nil "[Pinned notes~:[ carried from the last session~;, as of #~:*~d~] (keel_pin; a name pinned again replaces its note; any pinned since are in the conversation):~{~%- ~a~}]"
          as-of (mapcar #'format-pin pins)))

;;; --- a request, with what is out left out -----------------------------------------------

(defun message-key (m)
  "What ties a request's message to its session entry: role, time and call id."
  (format nil "~a|~a|~a" (json-get m "role") (js-string-of (json-get m "timestamp")) (or (json-get m "toolCallId") "")))

(defvar *chars-per-token* +default-chars-per-token+
  "Chars per token where a request is not there to calibrate on (keel_context, the
evict command): the model's own, as the last request measured it (limits.lisp).")

(defparameter +fit-min-tokens+ 2000 "Two requests' prompts this far apart measure the chars per token between them.")

(defun fit-chars-per-token (messages n-of branch chars-kept)
  "Chars per token of this session's messages, from two requests the provider
counted: the prompt grows by the messages added between them and nothing else,
so their chars over the tokens they added is the ratio, free of the system
prompt and tools, which both carry. CHARS-KEPT gives what a request sent
then. Requests made before the last compaction in MESSAGES sent what it
replaced, so they are left out. NIL without two requests far enough apart."
  (let* ((cutoff (or (loop for m across messages
                           when (and (json-object-p m) (member (json-get m "role") '("compactionSummary" "branchSummary") :test #'equal)
                                     (realp (json-get m "timestamp")))
                             maximize (json-get m "timestamp"))
                     -1))
         (points (loop for i from 0 below (length messages)
                       for m = (aref messages i)
                       for prompt = (and (json-object-p m) (usage-prompt-tokens m))
                       when (and prompt (or (not (realp (json-get m "timestamp"))) (> (json-get m "timestamp") cutoff)))
                         collect (cons (funcall chars-kept (let ((n (aref n-of i))) (if n (read-evictions branch n) (read-evictions branch))) i)
                                       prompt))))
    (when (rest points)
      (let ((a (first points)) (b (car (last points))))
        (when (and (>= (- (cdr b) (cdr a)) +fit-min-tokens+) (> (car b) (car a)))
          (clamp-chars-per-token (/ (dbl (- (car b) (car a))) (- (cdr b) (cdr a)))
                                 (cjk-share (loop for m across messages when (json-object-p m) collect (text-of (json-get m "content"))))))))))

(defun evict-request (branch index messages &key trigger auto (count 0) file mark mirror reread-prior)
  "What leaves REQUEST MESSAGES (a vector, the host's next request): the indices
to drop, the stubs (index . text) to put before them, the evict ops keel
records itself (AUTO and past +EVICT-AT-SHARE+ of TRIGGER), and the estimate
before and after: (values DROP STUBS OPS BEFORE AFTER). FILE is the session's,
whose kept originals the stubs read. With MARK (keel_context is there), each
request that starts a turn in the context starts with its #N, as `[#12]`, so the
agent can name turns to drop without listing them first: a turn's first #N
never changes, so the mark reads the same on every request. Then (or with anything
out) the pinned notes stand first, in one block (NOTES-BLOCK)."
  (let* ((turns (branch-turns branch index))
         (running (car (last turns)))
         (protected (let ((steps (and running (turn-steps running branch index))))
                      ;; The running turn's request and its newest step never leave.
                      (remove nil (list (first steps) (and (rest steps) (car (last steps)))))))
         (key-n (make-hash-table :test 'equal)) (id-of (make-hash-table))
         (outs (read-evictions branch))
         (n-of (make-array (length messages) :initial-element nil))
         (chars (make-hash-table)) (by-n (make-hash-table))
         (per-token +default-chars-per-token+) (fit nil) (ops '()) (reread nil) (reread-trials 0))
    (loop for i from (live-window-start branch) below (length branch)
          for e = (aref branch i)
          when (counted-entry-p e)
            do (let ((n (gethash (json-get e "id") index)))
                 (when n (setf (gethash (message-key (json-get e "message")) key-n) n (gethash n id-of) (json-get e "id")))))
    (loop for m across messages for i from 0
          for n = (and (json-object-p m) (gethash (message-key m) key-n))
          when n do (setf (aref n-of i) n (gethash n by-n) m) (incf (gethash n chars 0) (message-chars m)))
    (labels ((out-p (n outs) (and (out-of n outs) (notany (lambda (st) (<= (turn-from st) n (turn-to st))) protected)))
             ;; The request's message that holds the call a tool result answers.
             (holder (i)
               (let ((id (json-get (aref messages i) "toolCallId")))
                 (and (stringp id)
                      (loop for j from (1- i) downto 0
                            for m = (aref messages j)
                            when (and (json-object-p m) (equal (json-get m "role") "assistant")
                                      (some (lambda (c) (equal (call-id c) id)) (tool-calls-of m)))
                              return j))))
             ;; A message not tied to an entry (a custom one) goes with the entries around it: out when both are.
             (dropped (outs)
               (let ((v (make-array (length messages) :initial-element nil)))
                 (loop for i from 0 below (length messages)
                       for n = (aref n-of i)
                       do (setf (aref v i)
                                (if n
                                    (out-p n outs)
                                    (let ((before (loop for j from (1- i) downto 0 when (aref n-of j) return (aref n-of j)))
                                          (after (loop for j from (1+ i) below (length messages) when (aref n-of j) return (aref n-of j))))
                                      (and before (out-p before outs) (or (null after) (out-p after outs)))))))
                 ;; A result out while its call stays in keeps its place, its content a line
                 ;; (:replace): a call is never sent without its result.
                 (loop for i from 0 below (length messages)
                       for m = (aref messages i)
                       when (and (eq (aref v i) t) (aref n-of i) (json-object-p m) (equal (json-get m "role") "toolResult"))
                         do (let ((j (holder i))) (when (and j (not (aref v j))) (setf (aref v i) :replace))))
                 v))
             (chars-kept (outs &optional (below (length messages)))
               (let ((v (dropped outs))) (loop for i from 0 below below unless (aref v i) sum (message-chars (aref messages i))))))
      ;; Chars per token measured on this request's own messages, or the model's last measure.
      (setf fit (fit-chars-per-token messages n-of branch #'chars-kept) per-token (or fit *chars-per-token*))
      ;; The context now, estimated: what the provider counted for the latest
      ;; request, less what was sent then, is what the request holds besides the
      ;; messages (the system prompt, the tools); plus the messages kept now.
      (let* ((last-at (position-if (lambda (m) (and (json-object-p m) (usage-prompt-tokens m))) messages :from-end t))
             (overhead (if last-at
                           (let* ((m (aref messages last-at)) (made (aref n-of last-at))
                                  (then (if made (read-evictions branch made) outs)))
                             (max 0 (- (usage-prompt-tokens m) (tokens-from-chars (chars-kept then last-at) per-token))))
                           0))
             (before (+ overhead (tokens-from-chars (chars-kept outs) per-token)))
             (after before))
        (when auto
          (let* ((recalls (read-recalls branch)) (recent (recent-recalls recalls turns)))
            ;; A turn the agent recalled since it left comes back when that costs less than
            ;; the recalls it would still take, by how often this model recalls a turn
            ;; again and the session's prices (feedback.lisp); so do the turns linked to it (links.lisp).
            (multiple-value-setq (reread reread-trials) (reread-chance branch turns recalls reread-prior))
            (let* ((payback (eviction-payback (coerce messages 'list)))
                   (back (loop for (tr) in (recalled-out-turns turns branch recent)
                               when (restore-pays-p reread payback before
                                                    (tokens-from-chars (turn-chars tr chars) per-token)
                                                    (tokens-from-chars (loop for n being the hash-keys of chars using (hash-value c)
                                                                             when (and (> n (turn-to tr)) (not (out-of n outs))) sum c)
                                                                       per-token))
                                 collect tr)))
              (when back
                (dolist (tr (append back (linked-out back turns outs by-n)))
                  (push (evict-op "restore" (turn-from tr) (turn-to tr) "auto" count) ops)
                  (setf outs (remove-if (lambda (o) (overlaps-p (out-from o) (out-to o) (turn-from tr) (turn-to tr))) outs)))
                (setf before (+ overhead (tokens-from-chars (chars-kept outs) per-token)) after before)))
            (when (and (realp trigger) (> trigger 0) (> before (* +evict-at-share+ trigger)))
              ;; What can leave, oldest first, a turn the agent recalled lately after
              ;; the others: it leaves last of the finished turns, but before the
              ;; running turn's own steps are cut into. Held outright, it kept the
              ;; context at the trigger and every request took a sliver of the
              ;; running turn (a real 60-turn run: 285 evictions against 60, and
              ;; 2.4 times the prompt tokens).
              (let* ((finished (multiple-value-bind (held free) (partition (lambda (u) (held-turn-p u recent)) (turns-in turns outs))
                                 (append free held)))
                     ;; Then the running turn: first each of its tool results big enough to
                     ;; matter on its own, its call kept, so the turn's reasoning stays in view
                     ;; (VISTA, arXiv:2606.30005: a few large blocks hold most of a long
                     ;; context); only then its older steps, whole.
                     (candidates (append finished
                                         (mapcar (lambda (n) (make-turn n n)) (big-results turns branch index outs by-n chars per-token trigger protected))
                                         (nthcdr (length (turns-in turns outs)) (units-in turns branch index outs))))
                     (leaving '()) (counted (make-hash-table)))
                (dolist (u candidates)
                  (when (<= after (* +evict-to-share+ trigger)) (return))
                  (push u leaving)
                  ;; A step whose big result left before it is counted without it.
                  (loop for n from (turn-from u) to (turn-to u)
                        unless (or (out-of n outs) (gethash n counted))
                          do (setf (gethash n counted) t) (decf after (tokens-from-chars (gethash n chars 0) per-token))))
                (setf leaving (nreverse leaving))
                ;; The cut never falls inside a chain of linked turns (links.lisp).
                (when (and leaving (<= (length leaving) (length finished)) (member (car (last leaving)) finished))
                  (setf leaving (whole-chains leaving finished by-n)))
                (dolist (r (ranges-in leaving outs))
                  (push (evict-op "evict" (car r) (cdr r) "auto" count) ops)
                  (push (make-out (car r) (cdr r) "auto" nil count) outs))
                (setf outs (sort outs #'< :key #'out-from) after (+ overhead (tokens-from-chars (chars-kept outs) per-token)))))))
        ;; Each block of messages that leave gets one line, where the block was.
        (let* ((v (dropped outs)) (drop '()) (stubs '())
               ;; What the request leaves out altogether; a result replaced by its line stays in it.
               (gone (map 'vector (lambda (x) (eq x t)) v))
               ;; The originals of what leaves (only that), which the lines read.
               (originals (let ((h (make-hash-table))
                                (ns (sort (remove-duplicates (loop for i from 0 below (length messages)
                                                                   when (and (aref v i) (aref n-of i)) collect (aref n-of i)))
                                          #'<)))
                                (loop for n in ns for m in (restore-originals (mapcar (lambda (n) (gethash n by-n)) ns)
                                                                              (mapcar (lambda (n) (gethash n id-of)) ns) file)
                                      do (setf (gethash n h) m))
                                h)))
          ;; The pinned notes first, in view whatever has left (with keel_context there, or anything out).
          ;; First in the request: where the context's file is (MIRROR, its path), and the pinned notes.
          (when (or mark outs)
            (multiple-value-bind (shown as-of) (notes-as-of branch index ops)
              (let ((text (cond ((and mirror shown) (format nil "~a~%~a" (mirror-header mirror) (notes-block shown as-of)))
                                (mirror (mirror-header mirror))
                                (shown (notes-block shown as-of))))
                    (place (notes-place messages gone)))
                (when (and text place) (push (cons place text) stubs)))))
          (loop with i = 0
                while (< i (length messages))
                do (cond
                     ((not (aref v i)) (incf i))
                     ((eq (aref v i) :replace)
                      (push (cons (cons i "replace") (result-stub-text (aref n-of i) (aref messages i))) stubs)
                      (incf i))
                     (t
                       (let ((start i) (lo nil) (hi nil))
                         (loop while (and (< i (length messages)) (eq (aref v i) t))
                               do (let ((n (aref n-of i))) (when n (setf lo (min (or lo n) n) hi (max (or hi n) n))))
                                  (push i drop) (incf i))
                         (when lo (push (cons (stub-place messages gone start (1- i)) (stub-text lo hi turns outs by-n originals)) stubs))))))
          ;; The agent's notes put after an entry in its context's file, after that entry's message.
          (loop for (n . text) in (read-inserts branch)
                for i = (position n n-of)
                when (and i (not (aref gone i))) do (push (cons (cons i "append") text) stubs))
          (when mark
            (let ((starts (make-hash-table)))
              (dolist (tr turns) (setf (gethash (turn-from tr) starts) t))
              (loop for i from 0 below (length messages)
                    for n = (aref n-of i)
                    when (and n (not (aref v i)) (gethash n starts) (equal (json-get (aref messages i) "role") "user"))
                      do (push (cons (cons i "prepend") (turn-mark n)) stubs)))
            ;; The dashboard, at the very end of the request (dashboard, below).
            (let ((last-in (position nil gone :from-end t)))
              (when (and last-in (realp trigger) (> trigger 0))
                (push (cons (cons last-in "append") (dashboard after trigger turns outs chars per-token)) stubs))))
          (values (nreverse drop) (nreverse stubs) (nreverse ops) before after n-of v outs turns fit reread reread-trials))))))

(defun turn-mark (n) (format nil "[#~d]" n))

(defun big-results (turns branch index outs by-n chars per-token trigger protected)
  "The running turn's tool results that can leave on their own, oldest first: in
an older step (never its request or newest step), still in the context, and at
least +BIG-RESULT-SHARE+ of TRIGGER and +BIG-RESULT-MIN-TOKENS+. A step is a
call and what follows it, so its result is the step's last message but one at most."
  (let ((floor (max +big-result-min-tokens+ (* +big-result-share+ trigger))))
    (loop for st in (older-steps turns branch index)
          nconc (loop for n from (turn-from st) to (turn-to st)
                      when (and (not (out-of n outs))
                                (notany (lambda (p) (<= (turn-from p) n (turn-to p))) protected)
                                (equal (json-get (gethash n by-n) "role") "toolResult")
                                (>= (tokens-from-chars (gethash n chars 0) per-token) floor))
                        collect n))))

(defun result-stub-text (n m)
  "The line a tool result out on its own leaves as its content: its call stays
in the request. The same on every request, for the provider's cache."
  (let ((tool (json-get m "toolName")))
    (format nil "[#~d out of context: this~@[ ~a~] result, on its own; its call stays. It reads back word for word with ~a.]"
            n (and (stringp tool) tool) (recall-expand-call n))))

(defparameter +dashboard-largest+ 3 "The largest turns in the context the dashboard names.")

(defun dashboard (tokens trigger turns outs chars per-token)
  "How full the context is and what fills it, one line at the end of every request
while keel_context is there: models are blind to their own context's size (VISTA,
LightSpeed at Tencent, arXiv:2606.30005, measured a 43-84% median error without such
a dashboard and none with it, and its ablation lost 13 points of accuracy without
it, archiving and recovery kept). It is regenerated each request, as theirs is
after every tool result: the budget (tokens, the share of where the host compacts,
what is left), the largest turns in the context by #N, and what is out. At the end
of the request and not kept, it costs the provider's cache only its own tokens."
  (let* ((in (remove-if (lambda (tr) (turn-out-p tr outs)) turns))
         (largest (subseq (sort (copy-list in) #'> :key (lambda (tr) (turn-chars tr chars outs)))
                          0 (min +dashboard-largest+ (length in))))
         (out-turns (remove-if-not (lambda (tr) (turn-out-p tr outs)) turns))
         (tok (lambda (n) (js-string-of (round n)))))
    (format nil "[context: ~~~a tokens, ~d% of where the host compacts (~~~a), ~~~a left · ~a in~@[, largest ~{~a~^, ~}~] · ~a · ~a drops or restores turns by #N]"
            (funcall tok tokens) (round (* 100 tokens) trigger) (funcall tok trigger) (funcall tok (max 0 (- trigger tokens)))
            (plural (length in) "turn")
            (and largest (mapcar (lambda (tr) (format nil "~a ~~~a" (range-text (turn-from tr) (turn-to tr))
                                                      (funcall tok (tokens-from-chars (turn-chars tr chars outs) per-token))))
                                 largest))
            (if out-turns
                (let ((ranges (mapcar (lambda (o) (range-text (out-from o) (out-to o))) outs)))
                  (format nil "~a out (~{~a~^, ~})" (plural (length out-turns) "turn")
                          (if (> (length ranges) 2) (list (first ranges) "…" (car (last ranges))) ranges)))
                "nothing out")
            +context-tool+)))

(defparameter +user-side-roles+
  '("user" "custom" "hookMessage" "bashExecution" "pythonExecution" "fileMention" "branchSummary" "compactionSummary" "developer")
  "Roles the hosts' convertToLlm sends as the user's (omp's session/messages.ts): two of them in a row are two user messages.")

(defun stub-place (messages dropped start end)
  "Where the line for the messages START to END that leave goes, as (INDEX . HOW):
appended to the message before them or prepended to the one after, whichever is
sent as the user's (a tool result is too, for Anthropic and Google) and has a
content to carry text, so the request never holds two user messages in a row;
only between two that cannot carry it, as a message of its own (inserted before
INDEX)."
  (flet ((kept (from step) (loop for i = from then (+ i step) while (and (>= i 0) (< i (length messages)))
                                 unless (aref dropped i) return i))
         (carrier-p (i) (and i (let ((m (aref messages i)))
                                 (and (member (json-get m "role") (cons "toolResult" +user-side-roles+) :test #'equal)
                                      (let ((c (json-get m "content"))) (or (stringp c) (json-array-p c))))))))
    (let ((after (kept (1+ end) 1)) (before (kept (1- start) -1)))
      (cond ((carrier-p before) (cons before "append"))
            ((and (carrier-p after) (not (equal (json-get (aref messages after) "role") "toolResult"))) (cons after "prepend"))
            (t (cons start "insert"))))))

(defun notes-place (messages dropped)
  "Where the notes block goes: prepended to the first message the request keeps when
it is sent as the user's and can carry text, else a message of its own before it."
  (let ((i (position nil dropped)))
    (when i
      (let ((m (aref messages i)))
        (cons i (if (and (member (json-get m "role") +user-side-roles+ :test #'equal)
                         (let ((c (json-get m "content"))) (or (stringp c) (json-array-p c))))
                    "prepend" "insert"))))))

(defun budget-noted (branch)
  "The tenth of the trigger the model was last told of since the context last shrank
(a compaction, or turns the agent or the user took out; the auto eviction's own
shrink is what the note warns of, so it starts nothing again), 0 for none."
  (let ((level 0))
    (loop for i from (live-window-start branch) below (length branch)
          for e = (aref branch i)
          when (evict-entry-p e)
            do (let ((op (json-get e "data")))
                 (cond ((equal (json-get op "op") "budget") (setf level (let ((l (json-get op "level"))) (if (js-integer-p l) (as-integer l) 0))))
                       ((and (equal (json-get op "op") "evict") (member (json-get op "by") '("user" "agent") :test #'equal)) (setf level 0)))))
    level))

(defun budget-note (branch index after trigger tool count)
  "The note telling the model how full its context is and the op that records it,
when AFTER has reached a tenth of TRIGGER past +BUDGET-NOTE-FROM+ it was not yet
told of, TOOL (keel_context) is there, and something can leave: (values NOTE OP), or NIL."
  (when (and tool (realp trigger) (> trigger 0))
    (let ((level (min 9 (floor (* 10 after) trigger))))
      (when (and (>= level +budget-note-from+) (> level (budget-noted branch)) (room-to-evict-p branch index))
        (values (format nil "[keel: the context is past ~d0% of where the host compacts (~~~a tokens); past ~d% the oldest turns leave by themselves. keel_context lists what is in it and takes old turns out, with a note of what to keep.]"
                        level (js-string-of trigger) +evict-at-percent+)
                (json-object "v" 1 "op" "budget" "level" level "at" count))))))

(defun auto-notice (ops before after)
  "What the user is told when keel took turns out as the context filled, or brought back turns the agent kept recalling."
  (let ((ranges (lambda (kind) (loop for op in ops when (equal (json-get op "op") kind) collect (range-text (json-get op "from") (json-get op "to"))))))
    (join-strings
     (remove nil (list (let ((back (funcall ranges "restore")))
                         (and back (format nil "keel: ~{~a~^, ~} back in context · the agent keeps recalling ~:[it~;them~], and keeping ~:*~:[it~;them~] costs less than recalling ~:*~:[it~;them~] again." back (rest back))))
                       (let ((out (funcall ranges "evict")))
                         (and out (format nil "keel: Context ~~~a → ~~~a tokens · ~{~a~^, ~} out · by keel as the context filled; keel_recall expand reads any of it back."
                                          (js-string-of before) (js-string-of after) out)))))
     (string #\Newline))))

;;; --- the agent's and the user's calls -----------------------------------------------------

(defun ref-range (v)
  "A ref as given: N, \"#N\", \"#A-#B\" (or with an en dash): (FROM . TO), or NIL."
  (cond ((js-integer-p v) (cons (as-integer v) (as-integer v)))
        ((stringp v)
         (let ((m (rx-exec (rx "^\\s*#?(\\d+)\\s*(?:[-–]\\s*#?(\\d+))?\\s*$") v)))
           (when m
             (let ((a (parse-integer (rx-group m 1))) (b (and (rx-group m 2) (parse-integer (rx-group m 2)))))
               (cons (min a (or b a)) (max a (or b a)))))))))

(defun refs-of (v) (remove nil (mapcar #'ref-range (if (json-array-p v) (coerce v 'list) (and v (not (unset-p v)) (list v))))))

(defun turn-line (tr chars per-token messages-by-n outs &optional recent)
  (let ((m (gethash (turn-from tr) messages-by-n)))
    (format nil "~a ~~~a tokens~@[ \"~a\"~]~:[~; (older steps out)~]~:[~; (you recalled it lately: it leaves last)~]" (range-text (turn-from tr) (turn-to tr))
            (js-string-of (tokens-from-chars (turn-chars tr chars outs) per-token))
            (and m (equal (json-get m "role") "user") (request-words m))
            (some (lambda (o) (overlaps-p (out-from o) (out-to o) (turn-from tr) (turn-to tr))) outs)
            (held-turn-p tr recent))))

(defun list-context (turns outs chars by-n pins &optional recent)
  (let* ((in (remove-if (lambda (tr) (turn-out-p tr outs)) turns))
         (shown (last-n in +turns-listed+)))
    (format nil "In context: ~a, ~~~a tokens of messages (the last is the one running, which stays).~@[~%  (+~d older)~]~{~%  ~a~}~%~a~a"
            (plural (length in) "turn")
            (js-string-of (tokens-from-chars (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars outs)) in)) *chars-per-token*))
            (and (> (length in) (length shown)) (- (length in) (length shown)))
            (mapcar (lambda (tr) (turn-line tr chars *chars-per-token* by-n outs recent)) shown)
            (if outs
                (format nil "Out of context:~{~%  ~a~}"
                        (mapcar (lambda (o) (format nil "~a (~a)" (range-text (out-from o) (out-to o)) (span-what (out-from o) (out-to o) turns))) outs))
                "Nothing is out of context.")
            (if pins
                (format nil "~%Pinned (keel_pin; a name pinned again replaces its note):~{~%  ~a~}" (mapcar #'format-pin pins))
                ""))))

(defun eviction-cost (leaving turns outs chars)
  "What taking LEAVING out frees and what it makes the provider read again (the
context after its first #N that stays), in chars: (values FREED READ-AGAIN)."
  (let* ((from (reduce #'min (mapcar #'turn-from leaving)))
         (freed (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars outs)) leaving)))
         (after (loop for tr in turns
                      sum (loop for n from (max from (turn-from tr)) to (turn-to tr)
                                unless (or (out-of n outs) (some (lambda (l) (<= (turn-from l) n (turn-to l))) leaving))
                                  sum (gethash n chars 0)))))
    (values freed after)))

(defun pays-p (leaving turns outs chars payback)
  (multiple-value-bind (freed again) (eviction-cost leaving turns outs chars)
    (>= freed (* (payback-share payback) again))))

(defun not-worth-it (leaving turns outs chars payback)
  "Why the agent's eviction of LEAVING is refused, with the smallest run from the oldest end that would pay."
  (multiple-value-bind (freed again) (eviction-cost leaving turns outs chars)
    (let* ((in (turns-in turns outs))
           (k (loop for k from 1 to (length in) when (pays-p (subseq in 0 k) turns outs chars payback) return k))
           (tok (lambda (c) (js-string-of (tokens-from-chars c *chars-per-token*)))))
      (format nil "Not worth it: that frees ~~~a tokens but makes the provider read the ~~~a after it again; ~a, a drop must free ~d% of what it makes it read again. ~:[Nothing taken out would pay yet: wait until more of the context is old~;Take out more in one go, from the oldest end (oldest:~:*~d)~], or send force: true to take these out anyway (when you were asked to, or what they hold is done with)."
              (funcall tok freed) (funcall tok again) (payback-words payback) (round (* 100 (payback-share payback))) k))))

(defun evict-turns (leaving turns outs chars by note count &optional payback)
  "Record LEAVING (turns, oldest first) as out: (values TEXT OPS). With CHECK
(the agent's call), an eviction that does not pay (PAYBACK, EVICTION-PAYBACK) is refused."
  (let ((leaving (intersection leaving (turns-in turns outs))))
    (setf leaving (sort (copy-list leaving) #'< :key #'turn-from))
    (cond
      ((null leaving)
       (values "Nothing to take out: those turns are out already, or one is the turn running, which stays." '()))
      ((and payback (not (pays-p leaving turns outs chars payback)))
       (values (not-worth-it leaving turns outs chars payback) '()))
      (t
        (let ((ops (mapcar (lambda (r) (evict-op "evict" (car r) (cdr r) by count note)) (ranges-in leaving outs))))
          (values (format nil "Out of context from the next request: ~{~a~^, ~} (~a, ~~~a tokens). ~a reads any entry back word for word."
                          (mapcar (lambda (op) (range-text (json-get op "from") (json-get op "to"))) ops)
                          (plural (length leaving) "turn")
                          (js-string-of (tokens-from-chars (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars outs)) leaving)) *chars-per-token*))
                          (recall-expand-call (json-get (first ops) "from")))
                  ops))))))

(defun restore-turns (ranges outs by count)
  (let ((back (remove-if-not (lambda (o) (some (lambda (r) (overlaps-p (out-from o) (out-to o) (car r) (cdr r))) ranges)) outs)))
    (if (null back)
        (values "Nothing to bring back: no turn there is out of context." '())
        (values (format nil "Back in context from the next request: ~{~a~^, ~}." (mapcar (lambda (o) (range-text (out-from o) (out-to o))) back))
                (mapcar (lambda (o) (evict-op "restore" (out-from o) (out-to o) by count)) back)))))

(defun turns-touching (ranges turns)
  (remove-if-not (lambda (tr) (some (lambda (r) (overlaps-p (turn-from tr) (turn-to tr) (car r) (cdr r))) ranges)) turns))

(defun oldest-half (turns outs chars)
  "The oldest finished turns in context holding about half of their tokens."
  (let* ((in (turns-in turns outs))
         (half (/ (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars outs)) in)) 2)) (sum 0) (leaving '()))
    (dolist (tr in (nreverse leaving))
      (when (and leaving (>= sum half)) (return (nreverse leaving)))
      (push tr leaving) (incf sum (turn-chars tr chars outs)))))

(defun stamp-call (ops branch)
  "OPS, one call's, stamped with it: the number of ledger entries on BRANCH before
them, so undo tells two calls apart even with no message between them."
  (let ((call (count-if #'evict-entry-p branch)))
    (dolist (op ops ops) (setf (gethash "call" op) call))))

(defun same-call-p (a b)
  (if (and (js-integer-p (json-get a "call")) (js-integer-p (json-get b "call")))
      (= (json-get a "call") (json-get b "call"))
      (and (equal (json-get a "by") (json-get b "by")) (eql (op-at a) (op-at b)))))

(defun undo-last (branch by count)
  "The last context edit on BRANCH undone: every op of the last call (what it took
out, brought back, rewrote, or noted, in its context's file too) reversed, by
replaying the ledger without them and recording the difference. (values TEXT
OPS). An undo is an edit too, so a second one does the first again."
  (let* ((edit-p (lambda (e) (and (evict-entry-p e) (member (json-get (json-get e "data") "op") '("evict" "restore" "insert") :test #'equal))))
         (last (loop for i from (1- (length branch)) downto (1+ (last-reset-index branch))
                     when (funcall edit-p (aref branch i)) return i)))
    (if (null last)
        (values "Nothing to undo: no turn was taken out or brought back." '())
        (let* ((key (json-get (aref branch last) "data"))
               ;; One call's ops: the edits at the end of the ledger stamped with its call (STAMP-CALL), or else its author and #N count.
               (first (loop with first = last
                            for i from (1- last) downto (1+ (last-reset-index branch))
                            for e = (aref branch i)
                            do (when (funcall edit-p e)
                                 (if (same-call-p (json-get e "data") key)
                                     (setf first i)
                                     (return first)))
                            finally (return first)))
               (prefix (subseq branch 0 first))
               (was (read-evictions prefix)) (now (read-evictions branch))
               (same (lambda (a b) (and (= (out-from a) (out-from b)) (= (out-to a) (out-to b)) (equal (out-text a) (out-text b)))))
               (back (remove-if (lambda (o) (find o was :test same)) now))
               (again (remove-if (lambda (o) (find o now :test same)) was))
               (notes-was (read-inserts prefix)) (notes-now (read-inserts branch))
               (notes (remove-duplicates (append (mapcar #'car notes-was) (mapcar #'car notes-now))))
               (ops (append (mapcar (lambda (o) (evict-op "restore" (out-from o) (out-to o) by count)) back)
                            (mapcar (lambda (o) (let ((op (evict-op "evict" (out-from o) (out-to o) by count (out-note o))))
                                                  (when (out-text o) (setf (gethash "text" op) (out-text o)))
                                                  op))
                                    again)
                            (loop for n in (sort notes #'<)
                                  for before = (or (cdr (assoc n notes-was)) "")
                                  unless (equal before (or (cdr (assoc n notes-now)) ""))
                                    collect (json-object "v" 1 "op" "insert" "after" n "text" before "by" by "at" count)))))
          (values (format nil "Undone:~@[ ~{~a~^, ~} back in context~]~@[;~*~]~@[ ~{~a~^, ~} out of context again~]~@[;~*~]~@[ ~d note~:p as ~:*~[~;it was~:;they were~]~] from the next request."
                          (and back (mapcar (lambda (o) (range-text (out-from o) (out-to o))) back))
                          (and back (or again (plusp (length (remove-if-not (lambda (op) (equal (json-get op "op") "insert")) ops)))))
                          (and again (mapcar (lambda (o) (range-text (out-from o) (out-to o))) again))
                          (and again (some (lambda (op) (equal (json-get op "op") "insert")) ops))
                          (let ((k (count-if (lambda (op) (equal (json-get op "op") "insert")) ops))) (and (plusp k) k)))
                  ops)))))

(defun payback-of (by-n)
  (eviction-payback (mapcar #'cdr (sort (loop for n being the hash-keys of by-n using (hash-value m) collect (cons n m)) #'< :key #'car))))

(defun with-linked (ranges turns outs by-n)
  "RANGES to bring back, and the out turns linked to the ones they touch (links.lisp): those come back too."
  (let ((back (remove-if-not (lambda (tr) (turn-out-p tr outs)) (turns-touching ranges turns))))
    (append ranges (mapcar (lambda (tr) (cons (turn-from tr) (turn-to tr))) (linked-out back turns outs by-n)))))

(defun run-evict (call branch index chars by-n count)
  "One keel_context call or evict command on BRANCH: (values TEXT OPS). The agent's
evictions must pay, by the session's own prices (EVICTION-PAYBACK over BY-N)."
  (let* ((turns (branch-turns branch index)) (outs (read-evictions branch))
         (by (if (equal (json-get call "surface") "tool") "agent" "user")))
    (if (equal by "agent")
        (let* ((params (json-get call "params")) (drop (refs-of (json-get params "drop")))
               (restore (refs-of (json-get params "restore")))
               (oldest (let ((k (json-get params "oldest"))) (and (js-integer-p k) (> k 0) (as-integer k))))
               (note (let ((n (json-get params "note"))) (and (stringp n) (plusp (length (js-trim n))) (js-clip (js-trim n) +context-note-chars+))))
               ;; The agent was told the drop does not pay, and takes it out anyway.
               (force (eq (json-get params "force") :true)))
          (cond ((eq (json-get params "undo") :true) (undo-last branch by count))
                (restore (restore-turns (with-linked restore turns outs by-n) outs by count))
                (drop (evict-turns (turns-touching drop turns) turns outs chars by note count (and (not force) (payback-of by-n))))
                (oldest (let ((in (turns-in turns outs)))
                          (evict-turns (subseq in 0 (min oldest (length in))) turns outs chars by note count (and (not force) (payback-of by-n)))))
                (t (values (list-context turns outs chars by-n (read-pins branch) (recent-recalls (read-recalls branch) turns)) '()))))
        (let* ((args (js-trim (let ((a (json-get call "args"))) (if (stringp a) a ""))))
               (words (remove "" (rx-split (rx "\\s+") args) :test #'string=)))
          (cond ((zerop (length args))
                 ;; keel chooses where the cut falls, so it keeps linked chains whole (links.lisp).
                 (evict-turns (whole-chains (oldest-half turns outs chars) (turns-in turns outs) by-n) turns outs chars by nil count))
                ((string-equal args "undo") (undo-last branch by count))
                ((string-equal args "list") (values (list-context turns outs chars by-n (read-pins branch) (recent-recalls (read-recalls branch) turns)) '()))
                ((string-equal args "all") (evict-turns (finished-turns turns) turns outs chars by nil count))
                ((string-equal (first words) "restore")
                 (restore-turns (if (and (second words) (string-equal (second words) "all"))
                                    (list (cons 0 most-positive-fixnum))
                                    (with-linked (refs-of (coerce (rest words) 'vector)) turns outs by-n))
                                outs by count))
                ((every #'digit-char-p args)
                 (let ((in (turns-in turns outs)))
                   (evict-turns (subseq in 0 (min (parse-integer args) (length in))) turns outs chars by nil count)))
                ((refs-of (coerce words 'vector)) (evict-turns (turns-touching (refs-of (coerce words 'vector)) turns) turns outs chars by nil count))
                (t (values (format nil "Not understood: ~a. Give nothing (the oldest half), a number of turns, all, list, #A-#B, restore #A-#B, or undo." args) '())))))))
