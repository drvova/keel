;;;; working-set.lisp --- [Working Set]: what the next step needs, brought back.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The latest version of each file the work is on, the latest failed call
;;;; nothing later fixed, and what recall ranks highest for the latest request,
;;;; from the originals of everything out of context once the compaction lands
;;;; (calls.lisp reads the calls and results), within a budget and never more
;;;; than half of what the compaction removes.
;;;;
;;;; A summary says what happened; the next step needs what the agent was
;;;; working from: the file it is changing, the output of the call that just
;;;; failed. A compaction takes those out of context and the agent fetches them
;;;; again, a request each (re-exploration after eviction, arXiv:2606.11213;
;;;; tool calls made again after compression, arXiv:2608.29363). It reads
;;;; everything out of context, not only what this compaction summarizes: in
;;;; real sessions most files read again after a compaction were read before an
;;;; earlier one. The half-of-removed cap means a compaction always frees room.
;;;; It is chosen again at every compaction and never carried (the merge with
;;;; the previous summary keeps only the sections it knows), so it stays bounded
;;;; and is never rewritten. Nothing depends on wording: paths, failure flags,
;;;; recency, recall's own ranking, and what the agent recalled itself lately
;;;; (feedback.lisp recalled-newest-first), which says what it needs more surely than any of them.

(in-package #:keel)

(defparameter +min-item-chars+ 400 "Below this, an excerpt says too little to bring back.")
(defparameter +max-item-share+ 0.6d0
  "One item takes at most this share of the section, so a big file leaves room for the failure.")
(defparameter +max-relevant+ 3)
(defparameter +max-recalled+ 2 "Entries the agent recalled lately that come back, newest recall first.")
(defparameter +max-relevant-candidates+ 400
  "Recall ranks only the newest this many results, so a long session costs a compaction no more.")
(defparameter +head-allowance+ 200 "Room for an item's head line (`- #N read \"path\", note:`) when sizing its body.")
(defparameter +min-view-lines+ 2
  "Below this many lines, what a call showed of a file says too little to bring back (`ok`, `Successfully replaced`).")

(defun mentions-p (text path)
  "TEXT names PATH as a whole token, not as part of a longer one (`src/a.ts` in
`src/a.tsx`), and PATH names a file, not `.`."
  (and (rx-test (rx "[A-Za-z]") path)
       (rx-test (compile-regex (format nil "(?:^|[^\\w./-])~a(?![\\w/-]|\\.\\w)" (escape-regex path)) :ignore-case nil) text)))

;; An excerpt's line is quoted clipped at 300 chars, and costs the section the
;; line, its indent and its newline.
(defun quoted-line (line) (if (> (js-length line) 300) (concatenate 'string (js-slice line 0 300) "…") line))
(defun line-cost (line) (+ (js-length (quoted-line line)) 5))
(defun item-cap (max) (max +min-item-chars+ (js-round (* max +max-item-share+))))
(defun nonblank-lines (text) (remove-if (lambda (l) (zerop (length (js-trim l)))) (split-string text #\Newline)))
(defun excerpt-chars (text) (reduce #'+ (mapcar #'line-cost (nonblank-lines text))))
(defun line-count (text) (length (nonblank-lines text)))

(defun changed-after (r calls indices)
  "Where a file R's call read was changed after R, as \"P changed at #M\", or NIL:
what R shows of it no longer holds (MemTrace, arXiv:2610.04838, reuses evidence
only while it matches the repository's state)."
  (let ((c (result-call r)))
    (when (and c (on-file-p c) (not (changes-p c)))
      (loop for p in (files-of c)
            for later = (find-if (lambda (d) (and (> (call-pos d) (result-pos r)) (changes-p d) (member p (files-of d) :test #'string=))) calls)
            when later return (format nil "~a changed at #~a" p (js-string-of (nth (call-pos later) indices)))))))

(defstruct (ws-item (:constructor make-ws-item (index title note text from-end &optional whole))) index title note text from-end whole)

(defun select-working-set (history indices kept max-chars &optional recalled)
  "The items to bring back; RECALLED, the #N the agent recalled lately, newest first (feedback.lisp)."
  (unless (>= max-chars +min-item-chars+) (return-from select-working-set '()))
  (multiple-value-bind (all-calls results) (read-calls history :indices indices)
    (when (null results) (return-from select-working-set '()))
    (let* ((kept-calls (read-calls kept))
           (request (or (nth-value 1 (latest-request kept)) (nth-value 1 (latest-request history)) ""))
           (items '()) (used (make-hash-table))
           (last-user-pos (or (latest-request history) -1))
           (known (remove-duplicates (mapcan (lambda (c) (copy-list (files-of c))) (remove-if-not #'on-file-p all-calls)) :test #'string= :from-end t))
           (active '())
           (in-context (remove-duplicates (mapcan (lambda (c) (copy-list (files-of c))) (remove-if-not (lambda (c) (or (reads-one-p c) (writes-whole-p c))) kept-calls)) :test #'string=))
           (chosen '()))
      (flet ((add (p) (unless (member p active :test #'string=) (setf active (append active (list p))))))
        (dolist (c (reverse kept-calls)) (when (on-file-p c) (mapc #'add (files-of c))))
        (dolist (p known) (when (mentions-p request p) (add p)))
        ;; Then the files of the request in progress, read or changed since its
        ;; message, newest first: in real runs these are what the agent read
        ;; again after a compaction.
        (dolist (c (reverse all-calls)) (when (and (> (call-pos c) last-user-pos) (on-file-p c)) (mapc #'add (files-of c)))))
      ;; 1. Files the work is on, most recently touched first, unless the kept
      ;; tail already holds a read or a whole write of it.
      (dolist (path active)
        (unless (member path in-context :test #'string=)
          (let* ((touching (stable-sort (remove-if-not (lambda (c) (member path (files-of c) :test #'string=)) all-calls) #'< :key #'call-pos))
                 (base nil))
            (flet ((result-of (c) (let ((r (find c results :key #'result-call :test #'eq)))
                                    (and r (not (result-error r)) (plusp (length (js-trim (result-text r)))) r))))
              ;; Its last whole view: a write's content, or the result of a read of all of it.
              (dolist (c touching)
                (let ((whole (whole-text c)))
                  (cond (whole (setf base (list c whole (nth (call-pos c) indices))))
                        ((and (reads-one-p c) (not (reads-part-p c)))
                         (let ((r (result-of c))) (when r (setf base (list c (result-text r) (result-index r)))))))))
              ;; What showed it after that: omp's edit results (the changed lines,
              ;; numbered) and range reads. A file comes back whole, or as the lines
              ;; shown of it since, newest first while they fit, never as its first
              ;; lines: in real runs, after part of a file came back, the agent read
              ;; it again anyway.
              (let* ((after (remove-if-not (lambda (c) (and (> (call-pos c) (if base (call-pos (first base)) -1))
                                                            (or (edits-p c) (and (reads-one-p c) (reads-part-p c)))))
                                           touching))
                     (views (loop for c in after
                                  for r = (result-of c)
                                  when (and r (result-index r) (not (gethash (result-index r) used)) (>= (line-count (result-text r)) +min-view-lines+))
                                    collect (cons c r)))
                     (left (- (min max-chars (item-cap max-chars)) +head-allowance+))
                     (shown-views '()))
                (dolist (v (reverse views))
                  (let ((part (format nil "[#~a ~a]~%~a" (result-index (cdr v)) (title-of (car v)) (result-text (cdr v)))))
                    (when (> (excerpt-chars part) left) (return))
                    (setf shown-views (append shown-views (list (list (car v) (cdr v) part))))
                    (decf left (excerpt-chars part))))
                (let* ((base-part (and base (if shown-views
                                                 (format nil "[#~a ~a]~%~a" (js-string-of (third base)) (title-of (first base)) (second base))
                                                 (second base))))
                       (with-base (and base-part (plusp (length base-part)) (<= (excerpt-chars base-part) left))))
                  (when (or with-base shown-views)
                    (let ((index (if with-base (third base) (result-index (second (first shown-views))))))
                      (when (and index (not (gethash index used)))
                        (let* ((shown (mapcar #'first shown-views))
                               (later (loop for c in after
                                            when (and (edits-p c) (not (member c shown :test #'eq)) (nth (call-pos c) indices))
                                              collect (nth (call-pos c) indices)))
                               (kept-edits (some (lambda (c) (and (member path (files-of c) :test #'string=) (edits-p c))) kept-calls))
                               (note (join-strings (append (list (if with-base "the latest version" "its latest lines"))
                                                           (and shown-views (list "newest first"))
                                                           (cond (later (list (format nil "edited after at ~{#~a~^, ~}" later)))
                                                                 (kept-edits (list "edited after in context"))))
                                                   ", "))
                               (text (join-strings (append (mapcar #'third shown-views) (and with-base (list base-part))) (string #\Newline))))
                          (push (make-ws-item index (title-of (if with-base (first base) (first (first shown-views)))) note text nil t) items)
                          (setf (gethash index used) t)
                          (dolist (v shown-views) (setf (gethash (result-index (second v)) used) t))
                          (push path chosen)))))))))))
      ;; 2. The latest failure nothing later fixed, here or in what stays.
      (let ((open (find-if (lambda (r) (and (result-index r) (not (gethash (result-index r) used))
                                            (plusp (length (js-trim (result-text r))))))
                           (open-failures (nth-value 1 (read-calls (append history kept) :indices indices))))))
        (when open
          (push (make-ws-item (result-index open)
                              (format nil "~a [failed]" (title-of (result-call open)))
                              "its end" (result-text open) t)
                items)
          (setf (gethash (result-index open) used) t)))
      ;; 3. What the agent recalled lately: it went looking for these, so the
      ;; next step is likelier to need them than what a ranking guesses.
      (let ((taken 0))
        (dolist (n recalled)
          (when (>= taken +max-recalled+) (return))
          (let ((r (find-if (lambda (r) (and (result-index r) (not (gethash (result-index r) used)) (not (result-error r))
                                              (plusp (length (js-trim (result-text r))))
                                              ;; The entry itself, or the call whose result it is.
                                              (or (eql (result-index r) n)
                                                  (and (result-call r) (eql (nth (call-pos (result-call r)) indices) n)))))
                            results)))
            (when r
              (push (make-ws-item (result-index r) (title-of (result-call r))
                                  (let ((stale (changed-after r all-calls indices)))
                                    (if stale (format nil "recalled lately; ~a, so this may not hold" stale) "recalled lately"))
                                  (result-text r) nil)
                    items)
              (setf (gethash (result-index r) used) t)
              (incf taken)))))
      ;; 4. What recall ranks highest for the latest request.
      (when (plusp (length (js-trim request)))
        (let ((latest-run (make-hash-table :test 'equal)) (candidates '()))
          ;; Each run's latest result only: an earlier one is out of date. An edit's
          ;; or a write's result is the agent's own change, which rule 1 covers.
          (dolist (r results) (when (result-call r) (setf (gethash (run-of (result-call r)) latest-run) (result-pos r))))
          (dolist (r (last-n results +max-relevant-candidates+))
            (let ((c (result-call r)))
              (unless (or (null (result-index r)) (gethash (result-index r) used) (result-error r) (zerop (length (js-trim (result-text r))))
                          (and c (or (edits-p c) (writes-whole-p c)))
                          (and c (/= (gethash (run-of c) latest-run) (result-pos r)))
                          ;; A read of a file changed after it: what it shows no longer holds.
                          (changed-after r all-calls indices)
                          (some (lambda (p) (or (member p in-context :test #'string=) (member p chosen :test #'string=))) (and c (files-of c))))
                (let ((message (nth (result-pos r) history)))
                  (destructuring-bind (role summary files) (render-entry message)
                    (declare (ignore summary))
                    (push (list (result-index r) role (search-text message) files) candidates))))))
          (setf candidates (nreverse candidates))
          (when candidates
            (multiple-value-bind (hits) (search-docs (js-slice request 0 2000) (map 'vector #'rest candidates) :cap +max-relevant+ :interference nil)
              (unless (eq hits :aborted)
                (dolist (hit hits)
                  (let* ((index (first (nth (car hit) candidates)))
                         (r (find index results :key #'result-index :test #'eql)))
                    (when (and r (not (gethash index used)))
                      (push (make-ws-item index (title-of (result-call r)) "matches the latest request" (result-text r) nil) items)
                      (setf (gethash index used) t)))))))))
      (nreverse items))))

(defun excerpt (text max from-end)
  "(values LINES OMITTED): the nonblank lines of TEXT that fit MAX chars, from its start or its end."
  (let* ((all (nonblank-lines (js-trim-end text)))
         (order (if from-end (reverse all) all))
         (lines '()) (size 0))
    (dolist (line order)
      (when (> (+ size (line-cost line)) max) (return))
      (push (quoted-line line) lines)
      (incf size (line-cost line)))
    (let ((lines (if from-end lines (nreverse lines))))
      (values lines (- (length all) (length lines))))))

(defun format-working-set (items max-chars)
  "The section's lines and the #N they show: one head line per item, its excerpt
indented under it. A section has no blank line inside (the summary's sections are
told apart by them), and an indented line never reads as a section header."
  (let ((lines '()) (shown '()) (left max-chars))
    (dolist (item items)
      (let* ((head (format nil "- #~a ~a~@[, ~a~]:" (ws-item-index item) (ws-item-title item) (ws-item-note item)))
             (room (min (- left (js-length head)) (item-cap max-chars))))
        (when (< room +min-item-chars+) (return))
        (multiple-value-bind (body omitted) (excerpt (ws-item-text item) room (ws-item-from-end item))
          (unless (or (null body) (and (ws-item-whole item) (> omitted 0)))
            ;; Where the rest is: after the excerpt, or before it when the excerpt is the end.
            (let* ((more (if (> omitted 0)
                             (format nil "    …[~d ~a lines: ~a]" omitted (if (ws-item-from-end item) "earlier" "more") (recall-expand-call (ws-item-index item)))
                             ""))
                   (quoted (mapcar (lambda (l) (concatenate 'string "    " l)) body))
                   (block (append (list head)
                                  (and (plusp (length more)) (ws-item-from-end item) (list more))
                                  quoted
                                  (and (plusp (length more)) (not (ws-item-from-end item)) (list more)))))
              (setf lines (append lines block))
              (push (ws-item-index item) shown)
              (decf left (reduce #'+ (mapcar (lambda (l) (1+ (js-length l))) block))))))))
    (values lines (nreverse shown))))

(defun build-working-set (history indices kept budget-chars removed-chars &optional recalled)
  "The section for a compaction that removes REMOVED-CHARS, within BUDGET-CHARS
(the budgets' workingSetTokens) and at most half of what it removes."
  (let ((max (js-round (min budget-chars (* removed-chars 0.5d0)))))
    (format-working-set (select-working-set history indices kept max recalled) max)))
