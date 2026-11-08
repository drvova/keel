;;;; feedback.lisp --- what the agent recalled, read back as a signal.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A keel_recall call is a measurement of what the agent needs: the entries it
;;;; was shown are the ones it went looking for. Each call that showed this
;;;; session's entries leaves a keel.recall custom entry (in the session file,
;;;; never in the context, not counted in #N) holding their #N and the #N count
;;;; when it was made; the ledger is that, replayed along the branch since its
;;;; last /clear. Three things read it:
;;;;
;;;;;   - eviction (evict.lisp) takes a turn the agent recalled in the last
;;;;     +recall-hold-turns+ turns out last of the finished turns, whatever its
;;;;     age (before the running turn's own steps, though);
;;;;   - a turn out of the context that the agent recalled since it left comes
;;;;     back when that costs less than the recalls it would still take, by how
;;;;     often this model recalls a turn again (learned per model) and the
;;;;     session's own prices;
;;;;   - [Working Set] (working-set.lisp) brings back what was recalled before
;;;;     what recall's ranking would pick.

(in-package #:keel)

;;; A turn as eviction counts them (evict.lisp branch-turns), which this file and links.lisp read.
(defstruct (turn (:constructor make-turn (from to))) "A turn's first and last #N." from to)

;;; A run of #N out of the context, as the ledger replays it (evict.lisp read-evictions).
(defstruct (out (:constructor make-out (from to by note at &optional text)))
  "A run of #N out of the context: FROM to TO inclusive, by \"agent\", \"user\" or
\"auto\", the agent's NOTE, AT the #N count when it was recorded (requests
made after that left it out), and TEXT, what the agent rewrote it as in its
context's file (mirror.lisp), which stands in its place instead of the line."
  from to by note at text)

(defparameter +recall-hold-turns+ 3 "A recall counts for this many turns after it: the turn it was in, and the next ones.")
(defparameter +recall-max-shown+ 50 "The #N one recall entry holds at most.")

;;; What recall showed, while it runs (recall.lisp binds it for this session's
;;; view only; another session's #N are its own). :OFF when nothing records.
(defvar *shown-entries* :off)

(defun note-shown (indices)
  "INDICES were shown to the agent by the recall running now."
  (when (listp *shown-entries*)
    (dolist (n indices) (when (integerp n) (push n *shown-entries*)))))

(defun shown-entries ()
  "What the recall running now showed, oldest call first, each #N once, at most +recall-max-shown+."
  (if (listp *shown-entries*)
      (let ((ns (remove-duplicates (reverse *shown-entries*) :from-end t)))
        (subseq ns 0 (min (length ns) +recall-max-shown+)))
      '()))

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

(defun recent-recalls (recalls turns)
  "RECALLS made in the last +recall-hold-turns+ of TURNS (the running one counts)."
  (let ((since (if (> (length turns) +recall-hold-turns+)
                   (turn-from (nth (- (length turns) +recall-hold-turns+) turns))
                   0)))
    (remove-if (lambda (r) (< (cdr r) since)) recalls)))

(defun partition (pred list)
  "LIST's elements PRED holds for, and the others, each in LIST's order: (values YES NO)."
  (values (remove-if-not pred list) (remove-if pred list)))

(defun held-turn-p (turn recent)
  "Whether the agent recalled any of TURN recently (RECENT-RECALLS): it leaves last."
  (some (lambda (r) (<= (turn-from turn) (car r) (turn-to turn))) recent))

(defun recalled-out-turns (turns branch recent)
  "The finished TURNS out of the context now that the agent recalled since they
last left, counting the RECENT recalls: (TURN . RECALLS) each. Only since they
last left: a turn brought back and taken out again starts over, or the same
recalls would bring it back on every request (a real run did: 171 restores in
60 turns, when it counted every recent one)."
  (let ((outs (read-evictions branch)))
    (loop for tr in (finished-turns turns)
          for left = (and (turn-out-p tr outs) (out-at (out-of (turn-to tr) outs)))
          for k = (and left (length (remove-duplicates
                                     (loop for (n . at) in recent
                                           when (and (<= (turn-from tr) n (turn-to tr)) (> at left))
                                             collect at))))
          when (and k (plusp k)) collect (cons tr k))))

;;; --- whether bringing a turn back pays, for this model -----------------------------
;;;
;;; Models differ: some go back to an old turn again and again, some read it once
;;; and move on. A fixed rule (bring back after two recalls) is right for one and
;;; costly for the other, so keel learns it per model. After a recall of a turn
;;; out of the context, the agent either recalls it again within
;;; +recall-hold-turns+ turns (a continuation) or does not (a stop); Q, the chance
;;; of a continuation, is counted from this session's ledger and smoothed toward
;;; what the model showed before (keel-models.json rereadContinue), or
;;; +reread-prior+ for a model not seen yet. A recall whose window a restore cut
;;; short, or that has not passed yet, is not counted either way. With Q, the
;;; recalls a turn left out will still cost are Q / (1 - Q), each a whole request;
;;; bringing it back costs reading again all that follows it and carrying it on
;;; every later request, at the session's own prices (evict.lisp eviction-payback
;;; and restore-pays-p).

(defparameter +reread-prior+ 0.3d0 "Before a model shows its own: the chance it recalls a turn out of the context again, having recalled it once.")
(defparameter +reread-prior-weight+ 4 "How many recalls that prior counts as.")
(defparameter +reread-max+ 0.95d0 "Q is capped here, so a run of continuations never reads as certainty.")

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

(defun reread-evidence (branch turns recalls)
  "(values CONTINUED TRIALS) for the chance of recalling a turn out of the context again, from RECALLS ((N . AT)) on BRANCH."
  (let ((continued 0) (trials 0)
        (turn-at (lambda (at) (or (position-if (lambda (tr) (<= (turn-from tr) at)) turns :from-end t) 0))))
    (dolist (p (out-periods branch))
      (destructuring-bind (from to start end) p
        (let ((ats (sort (remove-duplicates (loop for (n . at) in recalls
                                                  when (and (<= from n to) (> at start) (or (null end) (<= at end)))
                                                    collect at))
                         #'<)))
          (loop for (at next) on ats
                for i = (funcall turn-at at)
                do (cond ((and next (<= (- (funcall turn-at next) i) +recall-hold-turns+)) (incf continued) (incf trials))
                         ;; Cut short by a restore before its window passed: unknown.
                         ((and end (<= (- (funcall turn-at end) i) +recall-hold-turns+)))
                         ;; Its window has passed with no recall: a stop.
                         ((> (- (1- (length turns)) i) +recall-hold-turns+) (incf trials)))))))
    (values continued trials)))

(defun reread-chance (branch turns recalls prior)
  "Q: the chance the agent recalls a turn out of the context again, this session's evidence smoothed toward PRIOR."
  (multiple-value-bind (continued trials) (reread-evidence branch turns recalls)
    (values (min +reread-max+ (/ (+ continued (* (or prior +reread-prior+) +reread-prior-weight+)) (+ trials +reread-prior-weight+)))
            trials)))


;;; What [Working Set] reads: the entries recalled, newest recall first.
(defvar *recalled* '())

(defun recalled-newest-first (recalls)
  (remove-duplicates (mapcar #'car (sort (copy-list recalls) #'> :key #'cdr)) :from-end t))
