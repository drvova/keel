;;;; evict.lisp --- whole turns out of the context, never rewritten, read back word for word.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The other way to make room: instead of a summary written over the oldest
;;;; part of the window, the oldest finished turns leave the context whole. The
;;;; session file keeps every word (vcc_recall expand:[N] reads any of them back
;;;; exactly, and search finds them); only the requests the host sends change. In
;;;; their place the request carries one line per run of turns that are out,
;;;; naming their #N and how to read them back. Context Language Models
;;;; (arXiv:2609.37725) let the model decide what leaves and found summaries "can
;;;; lose or hallucinate information"; nodecode drops the oldest finished turns
;;;; whole past 85% of the window. Here the agent decides with vcc_context, the
;;;; user with the evict command, and past +EVICT-AT-SHARE+ of the host's trigger
;;;; the oldest finished turns leave by themselves down to +EVICT-TO-SHARE+, so
;;;; the host's own compaction is rarely reached; when it is, the summary is the
;;;; safety net it always was.
;;;;
;;;; What is out is a ledger of omp-vcc custom entries (+evict-entry-type+),
;;;; replayed along the branch as pins are, so a branch keeps its own evictions
;;;; and an edited turn drops the ones made after it. A turn is the unit: it
;;;; starts at a request the user made and holds every call and result after it,
;;;; so a tool call never leaves without its result. The running turn never
;;;; leaves. Evictions drop far and rarely, from the oldest end, and the line in
;;;; their place is the same on every request: every edit makes the provider read
;;;; again all that follows it, so one large eviction costs less than many small
;;;; ones (the paper's harness tells its model the same).

(in-package #:omp-vcc)

(defparameter +evict-at-share+ (/ +evict-at-percent+ 100d0) "Past this share of the host's trigger, the oldest finished turns leave.")
(defparameter +evict-to-share+ 0.5d0 "They leave until the context is estimated at this share of the trigger.")
(defparameter +stub-requests-shown+ 3 "Requests a stub names of the turns it stands for.")
(defparameter +turns-listed+ 40 "Turns a listing shows, newest last.")
(defparameter +budget-note-from+ 5
  "From this tenth of the host's trigger on, the model is told how full its context
is and that vcc_context makes room, once per tenth: the paper's harness and
pi-clm keep the model budget-aware, or it never edits. The note is a message of
its own, stored in the session, so the provider's cache keeps it, unlike a line
that would change at the end of every request.")

;;; --- the ledger -------------------------------------------------------------------

(defun evict-entry-p (e)
  (and (equal (json-get e "type") "custom") (equal (json-get e "customType") +evict-entry-type+)
       (json-object-p (json-get e "data"))))

(defstruct (out (:constructor make-out (from to by note at)))
  "A run of #N out of the context: FROM to TO inclusive, by \"agent\", \"user\" or
\"auto\", the agent's NOTE, and AT the #N count when it was recorded (requests
made after that left it out)."
  from to by note at)

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
                                            (op-at op))
                                  outs))
                           ((equal (json-get op "op") "restore")
                            (setf outs (remove-if (lambda (o) (overlaps-p (out-from o) (out-to o) from to)) outs))))))))
    (sort outs #'< :key #'out-from)))

(defun out-of (n outs) (find-if (lambda (o) (<= (out-from o) n (out-to o))) outs))

(defun evict-op (kind from to by at &optional note)
  (json-object "v" 1 "op" kind "from" from "to" to "by" by "at" at "note" note))

;;; --- turns --------------------------------------------------------------------------

(defstruct (turn (:constructor make-turn (from to))) "A turn's first and last #N." from to)

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
  (let ((ranges '()))
    (dolist (u units (nreverse ranges))
      (loop for n from (turn-from u) to (turn-to u)
            unless (out-of n outs)
              do (if (and ranges (= n (1+ (cdr (first ranges))))) (setf (cdr (first ranges)) n) (push (cons n n) ranges))))))

;;; --- sizes and the line left in their place -------------------------------------------

(defun turn-chars (turn chars &optional outs)
  "The chars of TURN's messages (CHARS by #N), only those still in the context when OUTS is given."
  (loop for n from (turn-from turn) to (turn-to turn) unless (and outs (out-of n outs)) sum (gethash n chars 0)))

(defun request-words (message)
  (let ((words (user-words (rx-replace (host-block-regex) (text-of (json-get message "content")) "" :all t))))
    (and (plusp (length words)) (js-clip words 60))))

(defun by-words (bys)
  (let ((names (mapcar (lambda (b) (cond ((equal b "user") "the user") ((equal b "auto") "omp-vcc as the context filled") (t "the agent")))
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
read from the originals omp-vcc kept, ORIGINALS by #N), and how to read it back.
It names no size, and reads only what omp leaves as it is or the originals: the
line must read the same on every request for the provider's cache."
  (let* ((covering (remove-if-not (lambda (o) (overlaps-p (out-from o) (out-to o) from to)) outs))
         (requests (loop for n from from to to
                         for m = (gethash n messages-by-n)
                         for w = (and m (equal (json-get m "role") "user") (not (extension-user-p m)) (request-words m))
                         when w collect w))
         (shown (subseq requests 0 (min +stub-requests-shown+ (length requests))))
         (ns (loop for n from from to to when (gethash n originals) collect n))
         (range (and ns (range-of-window (map 'vector (lambda (n) (gethash n originals)) ns) (coerce ns 'vector))))
         (work (and range (range-work range)))
         (notes (remove nil (mapcar #'out-note covering))))
    (format nil "[~a out of context: ~a, by ~a.~@[ Requests: ~a.~]~@[ It ~a.~]~@[ The agent's note: ~a~] Each entry reads back word for word with ~a; vcc_recall query searches them.]"
            (range-text from to) (span-what from to turns) (by-words (mapcar #'out-by covering))
            (and shown (format nil "~{\"~a\"~^; ~}~@[ (+~d more)~]" shown (and (> (length requests) (length shown)) (- (length requests) (length shown)))))
            (and work (join-strings work "; "))
            (and notes (join-strings (mapcar (lambda (n) (if (find (char n (1- (length n))) ".!?") n (concatenate 'string n "."))) notes) " "))
            (recall-expand-call from))))

;;; --- a request, with what is out left out -----------------------------------------------

(defun message-key (m)
  "What ties a request's message to its session entry: role, time and call id."
  (format nil "~a|~a|~a" (json-get m "role") (js-string-of (json-get m "timestamp")) (or (json-get m "toolCallId") "")))

(defun evict-request (branch index messages &key trigger auto (count 0) file)
  "What leaves REQUEST MESSAGES (a vector, the host's next request): the indices
to drop, the stubs (index . text) to put before them, the evict ops omp-vcc
records itself (AUTO and past +EVICT-AT-SHARE+ of TRIGGER), and the estimate
before and after: (values DROP STUBS OPS BEFORE AFTER). FILE is the session's,
whose kept originals the stubs read."
  (let* ((turns (branch-turns branch index))
         (running (car (last turns)))
         (protected (let ((steps (and running (turn-steps running branch index))))
                      ;; The running turn's request and its newest step never leave.
                      (remove nil (list (first steps) (and (rest steps) (car (last steps)))))))
         (key-n (make-hash-table :test 'equal)) (id-of (make-hash-table))
         (outs (read-evictions branch))
         (n-of (make-array (length messages) :initial-element nil))
         (chars (make-hash-table)) (by-n (make-hash-table))
         (per-token +default-chars-per-token+) (ops '()))
    (loop for i from (live-window-start branch) below (length branch)
          for e = (aref branch i)
          when (counted-entry-p e)
            do (let ((n (gethash (json-get e "id") index)))
                 (when n (setf (gethash (message-key (json-get e "message")) key-n) n (gethash n id-of) (json-get e "id")))))
    (loop for m across messages for i from 0
          for n = (and (json-object-p m) (gethash (message-key m) key-n))
          when n do (setf (aref n-of i) n (gethash n by-n) m) (incf (gethash n chars 0) (message-chars m)))
    (labels ((out-p (n outs) (and (out-of n outs) (notany (lambda (st) (<= (turn-from st) n (turn-to st))) protected)))
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
                 v))
             (chars-kept (outs &optional (below (length messages)))
               (let ((v (dropped outs))) (loop for i from 0 below below unless (aref v i) sum (message-chars (aref messages i))))))
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
        (when (and auto (realp trigger) (> trigger 0) (> before (* +evict-at-share+ trigger)))
          (let ((leaving '()))
            (dolist (u (units-in turns branch index outs))
              (when (<= after (* +evict-to-share+ trigger)) (return))
              (push u leaving)
              (decf after (tokens-from-chars (turn-chars u chars outs) per-token)))
            (dolist (r (ranges-in (nreverse leaving) outs))
              (push (evict-op "evict" (car r) (cdr r) "auto" count) ops)
              (push (make-out (car r) (cdr r) "auto" nil count) outs))
            (setf outs (sort outs #'< :key #'out-from) after (+ overhead (tokens-from-chars (chars-kept outs) per-token)))))
        ;; Each block of messages that leave gets one line, where the block was.
        (let* ((v (dropped outs)) (drop '()) (stubs '())
               ;; The originals of what leaves (only that), which the lines read.
               (originals (let ((h (make-hash-table))
                                (ns (sort (remove-duplicates (loop for i from 0 below (length messages)
                                                                   when (and (aref v i) (aref n-of i)) collect (aref n-of i)))
                                          #'<)))
                                (loop for n in ns for m in (restore-originals (mapcar (lambda (n) (gethash n by-n)) ns)
                                                                              (mapcar (lambda (n) (gethash n id-of)) ns) file)
                                      do (setf (gethash n h) m))
                                h)))
          (loop with i = 0
                while (< i (length messages))
                do (if (not (aref v i))
                       (incf i)
                       (let ((start i) (lo nil) (hi nil))
                         (loop while (and (< i (length messages)) (aref v i))
                               do (let ((n (aref n-of i))) (when n (setf lo (min (or lo n) n) hi (max (or hi n) n))))
                                  (push i drop) (incf i))
                         (when lo (push (cons (stub-place messages v start (1- i)) (stub-text lo hi turns outs by-n originals)) stubs)))))
          (values (nreverse drop) (nreverse stubs) (nreverse ops) before after))))))

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
told of, TOOL (vcc_context) is there, and something can leave: (values NOTE OP), or NIL."
  (when (and tool (realp trigger) (> trigger 0))
    (let ((level (min 9 (floor (* 10 after) trigger))))
      (when (and (>= level +budget-note-from+) (> level (budget-noted branch)) (room-to-evict-p branch index))
        (values (format nil "[omp-vcc: the context is past ~d0% of where the host compacts (~~~a tokens); past ~d% the oldest turns leave by themselves. vcc_context lists what is in it and takes old turns out, with a note of what to keep.]"
                        level (js-string-of trigger) +evict-at-percent+)
                (json-object "v" 1 "op" "budget" "level" level "at" count))))))

(defun auto-notice (ops before after)
  "What the user is told when omp-vcc took turns out as the context filled."
  (format nil "omp-vcc: Context ~~~a → ~~~a tokens · ~{~a~^, ~} out · by omp-vcc as the context filled; vcc_recall expand reads any of it back."
          (js-string-of before) (js-string-of after)
          (mapcar (lambda (op) (range-text (json-get op "from") (json-get op "to"))) ops)))

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

(defun turn-line (tr chars per-token messages-by-n outs)
  (let ((m (gethash (turn-from tr) messages-by-n)))
    (format nil "~a ~~~a tokens~@[ \"~a\"~]~:[~; (older steps out)~]" (range-text (turn-from tr) (turn-to tr))
            (js-string-of (tokens-from-chars (turn-chars tr chars outs) per-token))
            (and m (equal (json-get m "role") "user") (request-words m))
            (some (lambda (o) (overlaps-p (out-from o) (out-to o) (turn-from tr) (turn-to tr))) outs))))

(defun list-context (turns outs chars by-n)
  (let* ((in (remove-if (lambda (tr) (turn-out-p tr outs)) turns))
         (shown (last-n in +turns-listed+)))
    (format nil "In context: ~a, ~~~a tokens of messages (the last is the one running, which stays).~@[~%  (+~d older)~]~{~%  ~a~}~%~a"
            (plural (length in) "turn")
            (js-string-of (tokens-from-chars (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars outs)) in)) +default-chars-per-token+))
            (and (> (length in) (length shown)) (- (length in) (length shown)))
            (mapcar (lambda (tr) (turn-line tr chars +default-chars-per-token+ by-n outs)) shown)
            (if outs
                (format nil "Out of context:~{~%  ~a~}"
                        (mapcar (lambda (o) (format nil "~a (~a)" (range-text (out-from o) (out-to o)) (span-what (out-from o) (out-to o) turns))) outs))
                "Nothing is out of context."))))

(defun evict-turns (leaving turns outs chars by note count)
  "Record LEAVING (turns, oldest first) as out: (values TEXT OPS)."
  (let ((leaving (intersection leaving (turns-in turns outs))))
    (setf leaving (sort (copy-list leaving) #'< :key #'turn-from))
    (if (null leaving)
        (values "Nothing to take out: those turns are out already, or one is the turn running, which stays." '())
        (let ((ops (mapcar (lambda (r) (evict-op "evict" (car r) (cdr r) by count note)) (ranges-in leaving outs))))
          (values (format nil "Out of context from the next request: ~{~a~^, ~} (~a, ~~~a tokens). ~a reads any entry back word for word."
                          (mapcar (lambda (op) (range-text (json-get op "from") (json-get op "to"))) ops)
                          (plural (length leaving) "turn")
                          (js-string-of (tokens-from-chars (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars outs)) leaving)) +default-chars-per-token+))
                          (recall-expand-call (json-get (first ops) "from")))
                  ops)))))

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

(defun run-evict (call branch index chars by-n count)
  "One vcc_context call or evict command on BRANCH: (values TEXT OPS)."
  (let* ((turns (branch-turns branch index)) (outs (read-evictions branch))
         (by (if (equal (json-get call "surface") "tool") "agent" "user")))
    (if (equal by "agent")
        (let* ((params (json-get call "params")) (drop (refs-of (json-get params "drop")))
               (restore (refs-of (json-get params "restore")))
               (oldest (let ((k (json-get params "oldest"))) (and (js-integer-p k) (> k 0) (as-integer k))))
               (note (let ((n (json-get params "note"))) (and (stringp n) (plusp (length (js-trim n))) (js-clip (js-trim n) +context-note-chars+)))))
          (cond (restore (restore-turns restore outs by count))
                (drop (evict-turns (turns-touching drop turns) turns outs chars by note count))
                (oldest (let ((in (turns-in turns outs)))
                          (evict-turns (subseq in 0 (min oldest (length in))) turns outs chars by note count)))
                (t (values (list-context turns outs chars by-n) '()))))
        (let* ((args (js-trim (let ((a (json-get call "args"))) (if (stringp a) a ""))))
               (words (remove "" (rx-split (rx "\\s+") args) :test #'string=)))
          (cond ((zerop (length args)) (evict-turns (oldest-half turns outs chars) turns outs chars by nil count))
                ((string-equal args "list") (values (list-context turns outs chars by-n) '()))
                ((string-equal args "all") (evict-turns (finished-turns turns) turns outs chars by nil count))
                ((string-equal (first words) "restore")
                 (restore-turns (if (and (second words) (string-equal (second words) "all"))
                                    (list (cons 0 most-positive-fixnum))
                                    (refs-of (coerce (rest words) 'vector)))
                                outs by count))
                ((every #'digit-char-p args)
                 (let ((in (turns-in turns outs)))
                   (evict-turns (subseq in 0 (min (parse-integer args) (length in))) turns outs chars by nil count)))
                ((refs-of (coerce words 'vector)) (evict-turns (turns-touching (refs-of (coerce words 'vector)) turns) turns outs chars by nil count))
                (t (values (format nil "Not understood: ~a. Give nothing (the oldest half), a number of turns, all, list, #A-#B, or restore #A-#B." args) '())))))))
