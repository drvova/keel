;;;; credit.lisp --- what each eviction cost, by kind of turn, learned per model.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; ContextPilot (Tencent Youtu, arXiv:2608.28476) trains an agent to edit its
;;;; own context and gives credit to each edit, not only to the whole episode.
;;;; Here the edit is an eviction and its credit needs no training: a turn the
;;;; agent recalled while it was out cost a request; one it never went back to
;;;; cost nothing. Counted by kind of turn (one that had a failed run, one that
;;;; changed files, one that only read), each kind's recall rate is learned per
;;;; model (keel-models.json recallAfterEvict), smoothed toward what the model
;;;; showed before, or the same +credit-prior+ for every kind. A free finished
;;;; turn of a kind the agent recalls at +credit-late-ratio+ times the cheapest
;;;; kind's rate or more leaves after the others; with no evidence every kind
;;;; reads the same and the oldest go first, as before.

(in-package #:keel)

(defparameter +credit-prior+ 0.2d0 "Before a model shows its own: the chance a turn of any kind is recalled while it is out.")
(defparameter +credit-prior-weight+ 4 "How many evictions that prior counts as.")
(defparameter +credit-late-ratio+ 2 "A kind recalled this many times as often as the cheapest leaves after it.")
(defparameter +credit-kinds+ '("failed" "changed" "read"))

(defun turn-kind (traits)
  "A turn's kind for credit: it had a failed run, else it changed a file, else it only read."
  (cond ((traits-failed traits) "failed") ((traits-changed traits) "changed") (t "read")))

(defun eviction-credit (branch turns recalls by-n)
  "Per kind, (RECALLED . TRIALS): of the finished TURNS each eviction on BRANCH
took out whole, how many the agent recalled (RECALLS, (N . AT)) while they were
out. One out with no recall counts once its window (+recall-hold-turns+ turns)
has passed; one brought back before then without a recall, not at all."
  (let ((credit (make-hash-table :test 'equal)) (traits (memo-traits by-n))
        (turn-at (lambda (at) (or (position-if (lambda (tr) (<= (turn-from tr) at)) turns :from-end t) 0))))
    (dolist (p (out-periods branch) credit)
      (destructuring-bind (from to start end) p
        (dolist (tr (finished-turns turns))
          (when (<= from (turn-from tr) (turn-to tr) to)
            (let* ((kind (turn-kind (funcall traits tr)))
                   (hit (some (lambda (r) (and (<= (turn-from tr) (car r) (turn-to tr)) (> (cdr r) start) (or (null end) (<= (cdr r) end))))
                              recalls))
                   (left (funcall turn-at start))
                   (until (if end (funcall turn-at end) (1- (length turns))))
                   (cell (or (gethash kind credit) (setf (gethash kind credit) (cons 0 0)))))
              (cond (hit (incf (car cell)) (incf (cdr cell)))
                    ((> (- until left) +recall-hold-turns+) (incf (cdr cell)))))))))))

(defun kind-rates (credit prior)
  "Per kind, the chance a turn of it is recalled while out: CREDIT smoothed toward
PRIOR (a hash of kind to rate, the model's) or +credit-prior+."
  (let ((rates (make-hash-table :test 'equal)))
    (dolist (k +credit-kinds+ rates)
      (let ((cell (gethash k credit '(0 . 0)))
            (p (let ((v (and (hash-table-p prior) (gethash k prior)))) (if (and (realp v) (<= 0 v 1)) v +credit-prior+))))
        (setf (gethash k rates) (/ (+ (car cell) (* p +credit-prior-weight+)) (+ (cdr cell) +credit-prior-weight+)))))))

(defun credit-shown (rates credit)
  "The RATES of the kinds the session's CREDIT has shown enough of (+credit-prior-weight+ evictions), to keep for the model; NIL for none."
  (when (and rates credit)
    (let ((shown (make-hash-table :test 'equal)))
      (dolist (k +credit-kinds+)
        (when (>= (cdr (gethash k credit '(0 . 0))) +credit-prior-weight+) (setf (gethash k shown) (gethash k rates))))
      (and (plusp (hash-table-count shown)) shown))))

(defun credit-order (free rates by-n)
  "FREE (finished turns, oldest first) with the turns of a kind recalled at
+credit-late-ratio+ times the cheapest kind's rate or more after the others,
each part oldest first."
  (let* ((traits (memo-traits by-n))
         (rate (lambda (tr) (gethash (turn-kind (funcall traits tr)) rates +credit-prior+)))
         (least (and free (reduce #'min (mapcar rate free)))))
    (if (and least (some (lambda (tr) (>= (funcall rate tr) (* +credit-late-ratio+ (max least 1d-6)))) free))
        (multiple-value-bind (late early) (partition (lambda (tr) (>= (funcall rate tr) (* +credit-late-ratio+ (max least 1d-6)))) free)
          (append early late))
        free)))
