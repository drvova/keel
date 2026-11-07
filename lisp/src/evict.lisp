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

(defun range-text (from to) (format nil "#~d–#~d" from to))

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
request the user made (not one another extension sent in the user's name); what
comes before the first request in the window is a turn of its own."
  (let ((turns '()))
    (loop for i from (live-window-start branch) below (length branch)
          for e = (aref branch i)
          for n = (and (counted-entry-p e) (gethash (json-get e "id") index))
          when n
            do (let ((m (json-get e "message")))
                 (if (or (null turns) (and (equal (json-get m "role") "user") (not (extension-user-p m))))
                     (push (make-turn n n) turns)
                     (setf (turn-to (first turns)) n))))
    (nreverse turns)))

(defun turn-out-p (turn outs) (and (out-of (turn-from turn) outs) t))

(defun finished-turns (turns) "Every turn but the newest, which is the one running." (butlast turns))

(defun turns-in (turns outs) "The finished TURNS still in the context: what can leave." (remove-if (lambda (tr) (turn-out-p tr outs)) (finished-turns turns)))

(defun room-to-evict-p (branch index) "Whether a finished turn on BRANCH is still in the context." (and (turns-in (branch-turns branch index) (read-evictions branch)) t))

(defun turn-of-n (n turns) (find-if (lambda (tr) (<= (turn-from tr) n (turn-to tr))) turns))

(defun runs-of (turns)
  "TURNS (in branch order) grouped into runs of adjacent ones: each turn starting at the #N after the last one's end."
  (let ((runs '()))
    (dolist (tr turns (nreverse (mapcar #'reverse runs)))
      (if (and runs (= (turn-from tr) (1+ (turn-to (first (first runs))))))
          (push tr (first runs))
          (push (list tr) runs)))))

;;; --- sizes and the line left in their place -------------------------------------------

(defun turn-chars (turn chars) (loop for n from (turn-from turn) to (turn-to turn) sum (gethash n chars 0)))

(defun request-words (message)
  (let ((words (user-words (rx-replace (host-block-regex) (text-of (json-get message "content")) "" :all t))))
    (and (plusp (length words)) (js-clip words 60))))

(defun by-words (bys)
  (let ((names (mapcar (lambda (b) (cond ((equal b "user") "the user") ((equal b "auto") "omp-vcc as the context filled") (t "the agent")))
                       (remove-duplicates bys :test #'equal :from-end t))))
    (join-strings names " and ")))

(defun stub-text (run outs messages-by-n)
  "The line a run of turns that are out leaves in the request: what it was and
how to read it back. It names no size: the turns' messages are what omp rewrites
in place, and the line must read the same on every request for the cache."
  (let* ((from (turn-from (first run))) (to (turn-to (car (last run))))
         (covering (remove-if-not (lambda (o) (overlaps-p (out-from o) (out-to o) from to)) outs))
         (requests (loop for tr in run
                         for m = (gethash (turn-from tr) messages-by-n)
                         for w = (and m (equal (json-get m "role") "user") (request-words m))
                         when w collect w))
         (shown (subseq requests 0 (min +stub-requests-shown+ (length requests))))
         (notes (remove nil (mapcar #'out-note covering))))
    (format nil "[~a out of context: ~a, by ~a.~@[ Requests: ~a.~]~@[ Note: ~a~] Each entry reads back word for word with ~a; vcc_recall query searches them.]"
            (range-text from to) (plural (length run) "turn") (by-words (mapcar #'out-by covering))
            (and shown (format nil "~{\"~a\"~^; ~}~@[ (+~d more)~]" shown (and (> (length requests) (length shown)) (- (length requests) (length shown)))))
            (and notes (join-strings (mapcar (lambda (n) (if (find (char n (1- (length n))) ".!?") n (concatenate 'string n "."))) notes) " "))
            (recall-expand-call from))))

;;; --- a request, with what is out left out -----------------------------------------------

(defun message-key (m)
  "What ties a request's message to its session entry: role, time and call id."
  (format nil "~a|~a|~a" (json-get m "role") (js-string-of (json-get m "timestamp")) (or (json-get m "toolCallId") "")))

(defun evict-request (branch index messages &key trigger auto (count 0))
  "What leaves REQUEST MESSAGES (a vector, the host's next request): the indices
to drop, the stubs (index . text) to put before them, the evict ops omp-vcc
records itself (AUTO and past +EVICT-AT-SHARE+ of TRIGGER), and the estimate
before and after: (values DROP STUBS OPS BEFORE AFTER)."
  (let* ((turns (branch-turns branch index))
         (key-n (make-hash-table :test 'equal))
         (outs (read-evictions branch))
         (n-of (make-array (length messages) :initial-element nil))
         (turn-at (make-array (length messages) :initial-element nil))
         (chars (make-hash-table)) (by-n (make-hash-table))
         (per-token +default-chars-per-token+) (ops '()))
    (loop for i from (live-window-start branch) below (length branch)
          for e = (aref branch i)
          when (counted-entry-p e)
            do (let ((n (gethash (json-get e "id") index))) (when n (setf (gethash (message-key (json-get e "message")) key-n) n))))
    ;; Each request message's #N, and the turn it is in (an unindexed one, a custom message, is in the turn before it).
    (let ((current nil))
      (loop for m across messages for i from 0
            for n = (and (json-object-p m) (gethash (message-key m) key-n))
            do (when n
                 (setf (aref n-of i) n current (turn-of-n n turns))
                 (incf (gethash n chars 0) (message-chars m))
                 (setf (gethash n by-n) m))
               (setf (aref turn-at i) current)))
    (labels ((kept-p (i outs) (let ((tr (aref turn-at i))) (not (and tr (not (eq tr (car (last turns)))) (turn-out-p tr outs)))))
             (chars-kept (outs &optional (below (length messages)))
               (loop for i from 0 below below when (kept-p i outs) sum (message-chars (aref messages i)))))
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
            (dolist (tr (turns-in turns outs))
              (when (<= after (* +evict-to-share+ trigger)) (return))
              (push tr leaving)
              (decf after (tokens-from-chars (turn-chars tr chars) per-token)))
            (dolist (run (runs-of (nreverse leaving)))
              (let ((op (evict-op "evict" (turn-from (first run)) (turn-to (car (last run))) "auto" count)))
                (push op ops)
                (push (make-out (turn-from (first run)) (turn-to (car (last run))) "auto" nil count) outs)))
            (setf outs (sort outs #'< :key #'out-from) after (+ overhead (tokens-from-chars (chars-kept outs) per-token)))))
        (let ((drop '()) (stubs '()))
          (dolist (run (runs-of (remove-if-not (lambda (tr) (turn-out-p tr outs)) (finished-turns turns))))
            (let ((first-at (position-if (lambda (tr) (member tr run)) turn-at)))
              (when first-at
                (push (cons first-at (stub-text run outs by-n)) stubs)
                (loop for i from first-at below (length messages)
                      while (or (null (aref turn-at i)) (member (aref turn-at i) run))
                      when (member (aref turn-at i) run) do (push i drop)))))
          (values (nreverse drop) (nreverse stubs) (nreverse ops) before after))))))

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

(defun turn-line (tr chars per-token messages-by-n)
  (let ((m (gethash (turn-from tr) messages-by-n)))
    (format nil "~a ~~~a tokens~@[ \"~a\"~]" (range-text (turn-from tr) (turn-to tr))
            (js-string-of (tokens-from-chars (turn-chars tr chars) per-token))
            (and m (equal (json-get m "role") "user") (request-words m)))))

(defun list-context (turns outs chars by-n)
  (let* ((in (remove-if (lambda (tr) (turn-out-p tr outs)) turns))
         (shown (last-n in +turns-listed+))
         (out-runs (runs-of (remove-if-not (lambda (tr) (turn-out-p tr outs)) turns))))
    (format nil "In context: ~a, ~~~a tokens of messages (the last is the one running, which stays).~@[~%  (+~d older)~]~{~%  ~a~}~%~a"
            (plural (length in) "turn")
            (js-string-of (tokens-from-chars (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars)) in)) +default-chars-per-token+))
            (and (> (length in) (length shown)) (- (length in) (length shown)))
            (mapcar (lambda (tr) (turn-line tr chars +default-chars-per-token+ by-n)) shown)
            (if out-runs
                (format nil "Out of context:~{~%  ~a~}"
                        (mapcar (lambda (run) (format nil "~a (~a)" (range-text (turn-from (first run)) (turn-to (car (last run)))) (plural (length run) "turn")))
                                out-runs))
                "Nothing is out of context."))))

(defun evict-turns (leaving turns outs chars by note count)
  "Record LEAVING (turns, oldest first) as out: (values TEXT OPS)."
  (let ((leaving (intersection leaving (turns-in turns outs))))
    (setf leaving (sort (copy-list leaving) #'< :key #'turn-from))
    (if (null leaving)
        (values "Nothing to take out: those turns are out already, or one is the turn running, which stays." '())
        (let ((ops (mapcar (lambda (run) (evict-op "evict" (turn-from (first run)) (turn-to (car (last run))) by count note))
                           (runs-of leaving))))
          (values (format nil "Out of context from the next request: ~{~a~^, ~} (~a, ~~~a tokens). ~a reads any entry back word for word."
                          (mapcar (lambda (op) (range-text (json-get op "from") (json-get op "to"))) ops)
                          (plural (length leaving) "turn")
                          (js-string-of (tokens-from-chars (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars)) leaving)) +default-chars-per-token+))
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
         (half (/ (reduce #'+ (mapcar (lambda (tr) (turn-chars tr chars)) in)) 2)) (sum 0) (leaving '()))
    (dolist (tr in (nreverse leaving))
      (when (and leaving (>= sum half)) (return (nreverse leaving)))
      (push tr leaving) (incf sum (turn-chars tr chars)))))

(defun run-evict (call branch index chars by-n count)
  "One vcc_context call or evict command on BRANCH: (values TEXT OPS)."
  (let* ((turns (branch-turns branch index)) (outs (read-evictions branch))
         (by (if (equal (json-get call "surface") "tool") "agent" "user")))
    (if (equal by "agent")
        (let* ((params (json-get call "params")) (drop (refs-of (json-get params "drop")))
               (restore (refs-of (json-get params "restore")))
               (oldest (let ((k (json-get params "oldest"))) (and (js-integer-p k) (> k 0) (as-integer k))))
               (note (let ((n (json-get params "note"))) (and (stringp n) (plusp (length (js-trim n))) (js-clip (js-trim n) +pin-chars+)))))
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
