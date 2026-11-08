;;;; links.lisp --- turns that belong together leave together.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Two turns are linked when the later one carries on what the earlier one
;;;; did: it changed a file the earlier one changed, or a run that failed in the
;;;; earlier one (the same tool on the same file, or the same command: run-of in
;;;; calls.lisp) succeeded in it. Taking out the earlier one and keeping the later
;;;; leaves half a story: a fix whose failure is gone, an edit of an edit whose
;;;; first form is gone. So where keel chooses which turns leave (its own
;;;; eviction as the context fills, the oldest-half command) the cut never falls
;;;; inside a linked chain, and bringing a turn back brings back the turns linked
;;;; to it on either side. The agent's and the user's explicit ranges are taken
;;;; as given. Nothing here reads wording: paths, runs and failure flags.

(in-package #:keel)

(defparameter +max-link-extend+ 3 "A cut moves at most this many turns to keep a chain whole.")

(defstruct (traits (:constructor make-traits (changed failed passed)))
  "What a turn did that a later one can carry on: the files it changed, the runs that failed and the runs that succeeded in it."
  changed failed passed)

(defun turn-traits (turn messages-by-n)
  "TURN's traits, from its messages in MESSAGES-BY-N (#N to message)."
  (let ((messages (loop for n from (turn-from turn) to (turn-to turn)
                        for m = (gethash n messages-by-n)
                        when m collect m)))
    (multiple-value-bind (calls results) (read-calls messages)
      (make-traits (remove-duplicates (mapcan (lambda (c) (copy-list (files-of c))) (remove-if-not #'changes-p calls)) :test #'string=)
                   (remove-duplicates (loop for r in results when (and (result-call r) (result-error r)) collect (run-of (result-call r))) :test #'string=)
                   (remove-duplicates (loop for r in results when (and (result-call r) (not (result-error r))) collect (run-of (result-call r))) :test #'string=)))))

(defun linked-p (earlier later)
  "Whether the turn with traits LATER carries on the one with traits EARLIER."
  (and (or (intersection (traits-changed earlier) (traits-changed later) :test #'string=)
           (intersection (traits-failed earlier) (traits-passed later) :test #'string=))
       t))

(defun memo-traits (messages-by-n)
  "A function from a turn to its traits, each worked out once."
  (let ((seen (make-hash-table :test 'equal)))
    (lambda (tr)
      (let ((key (cons (turn-from tr) (turn-to tr))))
        (or (gethash key seen) (setf (gethash key seen) (turn-traits tr messages-by-n)))))))

(defun whole-chains (leaving candidates messages-by-n)
  "LEAVING (a run of CANDIDATES from the oldest, each a turn) moved so it ends
between two turns that are not linked: on to the end of a chain the cut fell
inside, when that end is within +max-link-extend+ turns among CANDIDATES. Only
finished turns are moved over (a candidate whose #N is in a running turn's
steps is not one of them: the caller passes finished turns only)."
  (let ((traits (memo-traits messages-by-n)) (leaving (copy-list leaving)))
    (when leaving
      (loop repeat +max-link-extend+
            for next = (nth (length leaving) candidates)
            while (and next (linked-p (funcall traits (car (last leaving))) (funcall traits next)))
            do (setf leaving (append leaving (list next)))))
    leaving))

(defun linked-out (back turns outs messages-by-n)
  "The out turns linked to the turns of BACK (turns coming back) on either side,
chain by chain, at most +max-link-extend+ further each way: they come back too."
  (let ((traits (memo-traits messages-by-n))
        (out-turns (remove-if-not (lambda (tr) (turn-out-p tr outs)) (finished-turns turns)))
        (more '()))
    (dolist (b back)
      (let ((pos (position (turn-from b) out-turns :key #'turn-from)))
        (when pos
          ;; Older turns it carries on, then newer turns that carry on it.
          (loop for i downfrom (1- pos) to (max 0 (- pos +max-link-extend+))
                for prev = (nth (1+ i) out-turns)
                while (linked-p (funcall traits (nth i out-turns)) (funcall traits prev))
                do (push (nth i out-turns) more))
          (loop for i from (1+ pos) below (min (length out-turns) (+ pos 1 +max-link-extend+))
                for prev = (nth (1- i) out-turns)
                while (linked-p (funcall traits prev) (funcall traits (nth i out-turns)))
                do (push (nth i out-turns) more)))))
    (set-difference (remove-duplicates more) back)))
