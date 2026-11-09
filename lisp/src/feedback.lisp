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

(defparameter +recall-hold-turns+ 3 "A recall counts for this many turns after it: the turn it was in, and the next ones.")
(defparameter +recall-max-shown+ 50 "The #N one recall entry holds at most.")

(defun recent-recalls (recalls turns)
  "RECALLS made in the last +recall-hold-turns+ of TURNS (the running one counts)."
  (let ((since (if (> (length turns) +recall-hold-turns+)
                   (turn-from (nth (- (length turns) +recall-hold-turns+) turns))
                   0)))
    (remove-if (lambda (r) (< (cdr r) since)) recalls)))

(defun partition (pred list)
  "LIST's elements PRED holds for, and the others, each in LIST's order: (values YES NO)."
  (values (remove-if-not pred list) (remove-if pred list)))

(defparameter +came-back-hold-turns+ 12
  "A turn the agent came back to, in recalls far apart, is held this many turns after the last.")

(defun recall-episodes (turn recalls turns)
  "How many times the agent came back to TURN: its RECALLS ((N . AT)), in runs of
turns no more than +recall-hold-turns+ apart, each run one; and the index in TURNS
of the latest. (values EPISODES LAST)."
  (let ((at (sort (remove-duplicates (loop for (n . at) in recalls
                                           when (<= (turn-from turn) n (turn-to turn)) collect (turn-index-at at turns)))
                  #'<)))
    (values (if at (1+ (loop for (a b) on at when (and b (> (- b a) +recall-hold-turns+)) count t)) 0)
            (car (last at)))))

(defun came-back-p (turn recalls turns)
  "Whether the agent came back to TURN in recalls far apart (two episodes or more),
the last within +came-back-hold-turns+: a need that lasts, not a lookup. Recalls in
one run read a turn once and move on; ones that come back after a gap are what
lasts (the spacing effect; Cepeda et al., Psychological Bulletin 132(3), 2006)."
  (multiple-value-bind (episodes last) (recall-episodes turn recalls turns)
    (and (>= episodes 2) (<= (- (1- (length turns)) last) +came-back-hold-turns+))))

(defun held-turn-p (turn recalls turns)
  "Whether TURN leaves last: the agent recalled it in the last +recall-hold-turns+
turns (RECENT-RECALLS), or came back to it across gaps lately (CAME-BACK-P)."
  (or (some (lambda (r) (<= (turn-from turn) (car r) (turn-to turn))) (recent-recalls recalls turns))
      (came-back-p turn recalls turns)))

(defun recalled-out-turns (turns branch recent)
  "The finished TURNS out of the context now that the agent recalled since they
last left, counting the RECENT recalls: (TURN . RECALLS) each. Only since they
last left: a turn brought back and taken out again starts over, or the same
recalls would bring it back on every request (a real run did: 171 restores in
60 turns, when it counted every recent one)."
  (let ((outs (read-evictions branch)))
    (loop for tr in (finished-turns turns)
          for left = (and (turn-out-p tr outs) (out-at (out-of (turn-to tr) outs)))
          for k = (and left (length (recalls-while-out (turn-from tr) (turn-to tr) left nil recent)))
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

(defun reread-evidence (branch turns recalls)
  "(values CONTINUED TRIALS) for the chance of recalling a turn out of the context again, from RECALLS ((N . AT)) on BRANCH."
  (let ((continued 0) (trials 0))
    (dolist (p (out-periods branch))
      (destructuring-bind (from to start end) p
        (let ((ats (recalls-while-out from to start end recalls)))
          (loop for (at next) on ats
                for i = (turn-index-at at turns)
                do (cond ((and next (<= (- (turn-index-at next turns) i) +recall-hold-turns+)) (incf continued) (incf trials))
                         ;; Cut short by a restore before its window passed: unknown.
                         ((and end (<= (- (turn-index-at end turns) i) +recall-hold-turns+)))
                         ;; Its window has passed with no recall: a stop.
                         ((> (- (1- (length turns)) i) +recall-hold-turns+) (incf trials)))))))
    (values continued trials)))

(defun reread-chance (branch turns recalls prior)
  "Q: the chance the agent recalls a turn out of the context again, this session's evidence smoothed toward PRIOR."
  (multiple-value-bind (continued trials) (reread-evidence branch turns recalls)
    (values (min +reread-max+ (/ (+ continued (* (or prior +reread-prior+) +reread-prior-weight+)) (+ trials +reread-prior-weight+)))
            trials)))


(defun recalled-of (json)
  "The #N JSON's \"recalled\" lists: what the agent recalled lately, newest first, as a compaction reads it."
  (loop for n across (coerce (json-get json "recalled" #()) 'vector) when (js-integer-p n) collect (as-integer n)))

(defun recalled-newest-first (recalls)
  (remove-duplicates (mapcar #'car (sort (copy-list recalls) #'> :key #'cdr)) :from-end t))
