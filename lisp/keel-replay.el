;;; keel-replay.el --- Step recorded core requests through the live image.  -*- lexical-binding: t; -*-
;;;
;;; SPDX-License-Identifier: MIT
;;;
;;; A KEEL_REPLAY_OUT log (src/core.ts tapReplay: one JSON object per line,
;;; {request, response} or {request, response:null, error}) replayed against
;;; the connected image, step by step.  The core is deterministic, so a replay
;;; is exact: stepping a session's requests shows what each op decided and
;;; what state it carried, with the response diffed against the previous
;;; step's and against the recording (a mismatch after a core change is a
;;; regression, caught here instead of in bun test).
;;;
;;; C-c k r  keel-replay-start   (pick a .jsonl log, run its first step)
;;; C-c k n  keel-replay-next    (fire the next step)
;;; C-c k p  keel-replay-prev    (show the previous step, cached: no re-fire)
;;; C-c k a  keel-replay-auto    (run to the end or the first failure)
;;;
;;; Responses are compared as parsed JSON (plists would differ in key order;
;;; alists keep document order, and the deterministic core writes the same
;;; order).  A step whose live answer differs from the recording is marked
;;; MISMATCH in the report; a step the core refuses stops auto mode.

(require 'cl-lib)
(require 'keel-slime)

(defvar keel-replay--steps nil "Vector of parsed steps: each (request-alist recorded-response recorded-error).")
(defvar keel-replay--responses nil "Vector of live response strings, nil until a step runs.")
(defvar keel-replay--times nil "Vector of live step milliseconds.")
(defvar keel-replay--matches nil "Vector of t/nil: live response equals the recording.")
(defvar keel-replay--idx -1 "Current step index.")
(defvar keel-replay--file nil "Replay log under way.")
(defvar keel-replay--auto nil "Non-nil while auto mode chains steps.")

(defvar keel-replay-after-finish-hook nil
  "Hook run when auto mode finishes.  Functions take the report string.")

(defun keel-replay--parse (text)
  "TEXT parsed as JSON: objects as alists (document order kept), arrays as
vectors (so a list is always an object, never an array: json-serialize and
the diff below stay unambiguous).  Null and false both read as nil."
  (json-parse-string text :object-type 'alist :array-type 'array
                         :null-object nil :false-object nil))

(defun keel-replay--request-text (step)
  "The step's request re-serialized for the core."
  (json-serialize (nth 0 step)))

(defun keel-replay--op (step)
  "The step's op name."
  (cdr (assoc 'op (nth 0 step))))

(defun keel-replay--object-p (xs)
  "Non-nil when XS looks like a parsed JSON object: every element a (key . value) entry."
  (and (listp xs)
       (cl-every (lambda (e) (and (consp e) (not (consp (car-safe e))))) xs)))

(defun keel-replay--diff (a b path acc)
  "Collect (PATH OLD NEW) differences between parsed JSON A and B into ACC."
  (cond
   ((equal a b) acc)
   ((and (keel-replay--object-p a) (keel-replay--object-p b))
    (let ((keys (cl-remove-duplicates (append (mapcar #'car a) (mapcar #'car b)) :test #'equal)))
      (dolist (k keys acc)
        (let ((ea (assoc k a)) (eb (assoc k b)))
          (cond ((and ea eb) (setq acc (keel-replay--diff (cdr ea) (cdr eb) (cons k path) acc)))
                (ea (push (list (cons k path) (cdr ea) :missing) acc))
                (t (push (list (cons k path) :missing (cdr eb)) acc)))))))
   ((and (sequencep a) (sequencep b)
         (not (stringp a)) (not (stringp b))
         (not (keel-replay--object-p a)) (not (keel-replay--object-p b)))
    (let ((i 0) (la (length a)) (lb (length b)) (got acc))
      (while (< i (max la lb))
        (cond ((and (< i la) (< i lb))
               (setq got (keel-replay--diff (elt a i) (elt b i) (cons i path) got)))
              ((< i la)
               (push (list (cons i path) (elt a i) :missing) got))
              (t
               (push (list (cons i path) :missing (elt b i)) got)))
        (setq i (1+ i)))
      got))
   (t (cons (list path a b) acc))))

(defun keel-replay--format-value (v)
  "V shortened for display."
  (let ((s (format "%S" v)))
    (if (> (length s) 120) (concat (substring s 0 120) "...") s)))

(defun keel-replay--show-step ()
  "Render the current step into *keel-replay*."
  (let* ((step (aref keel-replay--steps keel-replay--idx))
         (live (aref keel-replay--responses keel-replay--idx))
         (prev (and (> keel-replay--idx 0) (aref keel-replay--responses (1- keel-replay--idx))))
         (buf (get-buffer-create "*keel-replay*")))
    (with-current-buffer buf
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "keel replay: %s  step %d/%d  op=%s\n"
                        keel-replay--file (1+ keel-replay--idx) (length keel-replay--steps)
                        (keel-replay--op step)))
        (if (null live)
            (insert "not run yet (keel-replay-next to fire it)\n")
          (insert (format "live: %s  %.0f ms  %s\n"
                          (if (and live (string-match-p "\"ok\": *true" live)) "ok" "FAILED")
                          (aref keel-replay--times keel-replay--idx)
                          (if (aref keel-replay--matches keel-replay--idx) "matches recording" "MISMATCH vs recording")))
          (insert "\n--- response ---\n" live "\n"))
        (when (and live prev)
          (let ((diffs (keel-replay--diff (keel-replay--parse prev) (keel-replay--parse live) nil nil)))
            (insert (format "\n--- changed since step %d (%d) ---\n" keel-replay--idx (length diffs)))
            (if (null diffs)
                (insert "identical\n")
              (dolist (d (cl-subseq diffs 0 (min 40 (length diffs))))
                (insert (format "%s:\n  was: %s\n  now: %s\n"
                                (mapconcat (lambda (p) (format "%s" p)) (reverse (nth 0 d)) ".")
                                (keel-replay--format-value (nth 1 d))
                                (keel-replay--format-value (nth 2 d))))))))))
    (pop-to-buffer buf)))

(defun keel-replay--fire (idx)
  "Fire step IDX at the connected image; its callback records and advances."
  (let* ((root (keel-slime-project-root))
         (step (aref keel-replay--steps idx))
         (request (keel-replay--request-text step))
         (started (float-time)))
    (unless root
      (error "keel-replay must run inside the keel project"))
    (unless (keel-slime-ensure-connection root)
      (error "SLIME did not connect within %s s" keel-slime-connect-timeout))
    (message "keel replay: step %d/%d op=%s ..." (1+ idx) (length keel-replay--steps) (keel-replay--op step))
    (slime-eval-async `(keel::json-pretty-string (keel::respond ,request))
                      (lambda (response)
                        (aset keel-replay--responses idx response)
                        (aset keel-replay--times idx (* 1000.0 (- (float-time) started)))
                        (aset keel-replay--matches idx
                              (if (nth 1 step)
                                  (equal (keel-replay--parse response) (nth 1 step))
                                ;; The recording holds a refusal: matches when live refuses too.
                                (not (string-match-p "\"ok\": *true" response))))
                        (keel-replay--show-step)
                        (when keel-replay--auto
                          (keel-replay--auto-advance))))))

(defun keel-replay--auto-advance ()
  "After a step in auto mode: stop on failure or at the end, else fire next."
  (let ((live (aref keel-replay--responses keel-replay--idx)))
    (cond ((or (null live) (not (string-match-p "\"ok\": *true" live)))
           (setq keel-replay--auto nil)
           (keel-replay--finish (format "stopped at step %d: the core refused it" (1+ keel-replay--idx))))
          ((>= (1+ keel-replay--idx) (length keel-replay--steps))
           (setq keel-replay--auto nil)
           (keel-replay--finish "all steps answered ok"))
          (t
           (setq keel-replay--idx (1+ keel-replay--idx))
           (keel-replay--fire keel-replay--idx)))))

(defun keel-replay--finish (verdict)
  "Report the run and run the hook."
  (let ((report (with-temp-buffer
                  (insert (format "keel replay: %s\n%s\n\n" keel-replay--file verdict))
                  (dotimes (i (length keel-replay--steps))
                    (let ((live (aref keel-replay--responses i)))
                      (insert (format "%3d %-12s %-7s %7.0f ms %s\n" (1+ i)
                                      (keel-replay--op (aref keel-replay--steps i))
                                      (cond ((null live) "skipped")
                                            ((string-match-p "\"ok\": *true" live) "ok")
                                            (t "FAILED"))
                                      (or (aref keel-replay--times i) 0)
                                      (cond ((null live) "")
                                            ((aref keel-replay--matches i) "matches recording")
                                            (t "MISMATCH vs recording"))))))
                  (buffer-string))))
    (pop-to-buffer (get-buffer-create "*keel-replay-report*"))
    (with-current-buffer "*keel-replay-report*"
      (let ((inhibit-read-only t)) (erase-buffer) (insert report)))
    (run-hook-with-args 'keel-replay-after-finish-hook report)
    (message "keel replay: %s" verdict)))

;;;###autoload
(defun keel-replay-start (file)
  "Replay FILE (a KEEL_REPLAY_OUT log) against the connected image, first step fired."
  (interactive "fReplay log: ")
  (let ((steps (with-temp-buffer
                 (insert-file-contents file)
                 (cl-loop for line in (split-string (buffer-string) "\n" t)
                          collect (let ((rec (keel-replay--parse line)))
                                    (list (cdr (assoc 'request rec))
                                          (cdr (assoc 'response rec))
                                          (cdr (assoc 'error rec))))))))
    (unless steps
      (error "keel-replay: no steps in %s" file))
    (setq keel-replay--steps (vconcat steps)
          keel-replay--responses (make-vector (length steps) nil)
          keel-replay--times (make-vector (length steps) 0)
          keel-replay--matches (make-vector (length steps) nil)
          keel-replay--idx 0
          keel-replay--file file
          keel-replay--auto nil)
    (keel-replay--show-step)))

;;;###autoload
(defun keel-replay-next ()
  "Fire the next step (or show it when already run)."
  (interactive)
  (unless keel-replay--steps
    (error "keel-replay: no run (keel-replay-start first)"))
  (when (< (1+ keel-replay--idx) (length keel-replay--steps))
    (setq keel-replay--idx (1+ keel-replay--idx)))
  (if (aref keel-replay--responses keel-replay--idx)
      (keel-replay--show-step)
    (keel-replay--fire keel-replay--idx)))

;;;###autoload
(defun keel-replay-prev ()
  "Show the previous step (cached: nothing is re-fired, the core is deterministic)."
  (interactive)
  (unless keel-replay--steps
    (error "keel-replay: no run (keel-replay-start first)"))
  (when (> keel-replay--idx 0)
    (setq keel-replay--idx (1- keel-replay--idx)))
  (keel-replay--show-step))

;;;###autoload
(defun keel-replay-auto ()
  "Run every remaining step; stop at the first failure, then report."
  (interactive)
  (unless keel-replay--steps
    (error "keel-replay: no run (keel-replay-start first)"))
  (setq keel-replay--auto t)
  (if (aref keel-replay--responses keel-replay--idx)
      (keel-replay--auto-advance)
    (keel-replay--fire keel-replay--idx)))

(with-eval-after-load 'keel-slime
  (with-eval-after-load 'slime
    (when (boundp 'slime-mode-map)
      (let ((prefix (lookup-key slime-mode-map (kbd "C-c k"))))
        (when (keymapp prefix)
          (define-key prefix (kbd "r") #'keel-replay-start)
          (define-key prefix (kbd "n") #'keel-replay-next)
          (define-key prefix (kbd "p") #'keel-replay-prev)
          (define-key prefix (kbd "a") #'keel-replay-auto))))))

(provide 'keel-replay)
;;; keel-replay.el ends here
