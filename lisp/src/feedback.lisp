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
;;;;   - eviction (evict.lisp) leaves a turn the agent recalled in the last
;;;;     +recall-hold-turns+ turns in the context, whatever its age;
;;;;   - a turn out of the context that the agent recalled twice in that time
;;;;     comes back (the first recall answers itself; a second says the eviction
;;;;     was wrong, and each recall costs a call and repeats the text);
;;;;   - [Working Set] (working-set.lisp) brings back what was recalled before
;;;;     what recall's ranking would pick.

(in-package #:keel)

;;; A turn as eviction counts them (evict.lisp branch-turns), which this file and links.lisp read.
(defstruct (turn (:constructor make-turn (from to))) "A turn's first and last #N." from to)

(defparameter +recall-hold-turns+ 3 "A recall counts for this many turns after it: the turn it was in, and the next ones.")
(defparameter +recall-reads-to-restore+ 2 "Recalled this many times while out of the context, a turn comes back.")
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

(defun held-turn-p (turn recent)
  "Whether the agent recalled any of TURN recently (RECENT-RECALLS): it stays in the context."
  (some (lambda (r) (<= (turn-from turn) (car r) (turn-to turn))) recent))

(defun reread-turns (turns branch recent)
  "The finished TURNS out of the context now that the agent recalled at least
+recall-reads-to-restore+ times while they were out, counting the RECENT
recalls (each recall call once per turn)."
  (let ((outs (read-evictions branch)))
    (loop for tr in (finished-turns turns)
          when (and (turn-out-p tr outs)
                    (>= (length (remove-duplicates
                                 (loop for (n . at) in recent
                                       when (and (<= (turn-from tr) n (turn-to tr)) (out-of n (read-evictions branch at)))
                                         collect at)))
                        +recall-reads-to-restore+))
            collect tr)))

;;; What [Working Set] reads: the entries recalled, newest recall first.
(defvar *recalled* '())

(defun recalled-newest-first (recalls)
  (remove-duplicates (mapcar #'car (sort (copy-list recalls) #'> :key #'cdr)) :from-end t))
