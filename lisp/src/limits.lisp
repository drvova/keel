;;;; limits.lisp --- a model's real window, learned from overflow errors.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; With the decision src/compaction.ts asks for once a run settles.
;;;; keel takes the window from the host and makes no network call of its
;;;; own; when a provider serves less, the limit its overflow error states
;;;; ("maximum context length is 32768 tokens") is kept per model in keel-models.json next to the config, with the
;;;; host's compaction policy as the latest compaction for that model carried it,
;;;; so a later session starts from both.

(in-package #:keel)

(defparameter +limits-file+ "keel-models.json")
(defparameter +legacy-limits-file+ "omp-vcc-models.json" "What keel learned as omp-vcc: read until keel-models.json is written.")

(defun model-key (model)
  "The key the limits file names MODEL by: provider/id, or NIL without both."
  (let ((provider (json-get model "provider")) (id (json-get model "id")))
    (and (truthy-p provider) (truthy-p id) (format nil "~a/~a" (js-string-of provider) (js-string-of id)))))

(defun limits-path (dir &optional (file +limits-file+)) (join-path dir file))

(defun read-limits (dir)
  "The limits file's object, or an empty one (no file, or not an object: keel writes it again)."
  (let ((parsed (if (probe-file (native-path (limits-path dir)))
                    (read-json-file (limits-path dir))
                    (read-json-file (limits-path dir +legacy-limits-file+)))))
    (if (hash-table-p parsed) parsed (make-hash-table :test 'equal))))

(defun write-limits (dir limits)
  (ignore-errors (write-text-file (limits-path dir) (format nil "~a~%" (json-pretty-string limits))) t))

(defun limit-of (limits key)
  "What LIMITS keeps of model KEY: an object, or NIL."
  (let ((v (and key (json-get limits key)))) (and (hash-table-p v) v)))

(defun entry-copy (value) "A copy of object VALUE to write into, or an empty one." (if (hash-table-p value) (spread-object value) (make-hash-table :test 'equal)))

(defun round-2 (x) "X to two decimals, as the file keeps a measure." (/ (round (* x 100)) 100d0))

(defun moved-p (new old &key relative)
  "Whether NEW is worth writing over OLD: OLD is none, or NEW differs by more than 0.05 (by 5% of OLD with RELATIVE)."
  (and (realp new) (or (not (realp old)) (> (abs (- new old)) (if relative (* 0.05 old) 0.05d0)))))

(defun iso-now ()
  "new Date().toISOString(), to the millisecond."
  (multiple-value-bind (seconds microseconds) (sb-ext:get-time-of-day)
    (multiple-value-bind (s m h day month year) (decode-universal-time (+ seconds 2208988800) 0)
      (format nil "~4,'0d-~2,'0d-~2,'0dT~2,'0d:~2,'0d:~2,'0d.~3,'0dZ" year month day h m s (floor microseconds 1000)))))

(defun learned-window (dir key)
  (let ((n (json-get (limit-of (read-limits dir) key) "contextWindow")))
    (and (realp n) (> n 0) n)))

(defun record-learned-window (dir key window &optional (now (iso-now)))
  "Keep the limit an overflow error stated for KEY: a smaller limit replaces a larger one, never the reverse."
  (when (and key (realp window) (> window 0))
    (let* ((limits (read-limits dir))
           (known (json-get (limit-of limits key) "contextWindow")))
      ;; Unless a smaller one stands; one the provider has since outgrown (a larger prompt accepted) gives way.
      (unless (and (realp known) (<= known window)
                   (not (let ((a (json-get (limit-of limits key) "maxPromptTokens"))) (and (realp a) (> a known)))))
        (let ((entry (entry-copy (limit-of limits key))))
          (setf (gethash "contextWindow" entry) window (gethash "source" entry) "overflow-error" (gethash "at" entry) now
                (gethash key limits) entry))
        (write-limits dir limits)))))

(defparameter +chars-per-token-seen+ 8 "The measured chars per token kept per model, newest last.")

(defun record-evidence (dir key &key prompt chars-per-token reread recall-by-kind)
  "Keep what a request proved of KEY's window and tokens: PROMPT, the largest prompt
the provider accepted (the window is at least that), and CHARS-PER-TOKEN, the
latest calibration of the session's messages against the provider's count
(a model's tokenizer is its own: Claude 4.7 counts about 30% more tokens than
4.6 for the same text). Written only when the largest prompt grew or the
calibration moved by more than 5%, or REREAD, how often the model recalls a turn
again (feedback.lisp), or RECALL-BY-KIND, a hash of each kind of turn's chance of
being recalled once out (credit.lisp), moved by more than 0.05; each chars-per-token value it moved to is kept, the last
+chars-per-token-seen+ of them (LEARNED-CHARS-PER-TOKEN reads the lowest)."
  (when key
    (let* ((limits (read-limits dir)) (known (limit-of limits key))
           (was-prompt (json-get known "maxPromptTokens")) (was-cpt (json-get known "charsPerToken"))
           (grew (and (realp prompt) (> prompt 0) (or (not (realp was-prompt)) (> prompt was-prompt))))
           (moved (moved-p chars-per-token was-cpt :relative t))
           (reread-moved (moved-p reread (json-get known "rereadContinue")))
           (was-kinds (json-get known "recallAfterEvict"))
           (kinds-moved (and (hash-table-p recall-by-kind)
                             (loop for k being the hash-keys of recall-by-kind using (hash-value v)
                                   thereis (moved-p v (and (json-object-p was-kinds) (json-get was-kinds k)))))))
      (when (or grew moved reread-moved kinds-moved)
        (let ((entry (entry-copy known)))
          (when grew (setf (gethash "maxPromptTokens" entry) prompt))
          (when reread-moved (setf (gethash "rereadContinue" entry) (round-2 reread)))
          (when kinds-moved
            (let ((kinds (entry-copy was-kinds)))
              (maphash (lambda (k v) (setf (gethash k kinds) (round-2 v))) recall-by-kind)
              (setf (gethash "recallAfterEvict" entry) kinds)))
          (when moved
            (let ((value (round-2 chars-per-token))
                  (seen (let ((v (json-get known "charsPerTokenSeen"))) (if (json-array-p v) (remove-if-not #'realp (coerce v 'list)) '()))))
              (setf (gethash "charsPerToken" entry) value
                    (gethash "charsPerTokenSeen" entry) (coerce (last (append seen (list value)) +chars-per-token-seen+) 'vector))))
          (setf (gethash key limits) entry)
          (write-limits dir limits))))))

(defun learned-reread (dir key)
  "How often KEY's model recalls a turn out of the context again, having recalled it once, as its last session showed (feedback.lisp), or NIL."
  (let ((q (json-get (limit-of (read-limits dir) key) "rereadContinue"))) (and (realp q) (<= 0 q 1) q)))

(defun learned-recall-by-kind (dir key)
  "How often KEY's model recalled a turn of each kind once it was out (credit.lisp), as a hash of kind to rate, or NIL."
  (let ((kinds (json-get (limit-of (read-limits dir) key) "recallAfterEvict")))
    (when (json-object-p kinds)
      (let ((h (make-hash-table :test 'equal)))
        (maphash (lambda (k v) (when (and (realp v) (<= 0 v 1)) (setf (gethash k h) v))) kinds)
        h))))

(defun learned-chars-per-token (dir key)
  "KEY's chars per token, from the low side: the fewest chars a token of the values
measured lately, so the tokens estimated from it are an upper bound. A wrong
estimate costs unevenly: too high and a turn leaves a little early, too low and
the request overflows; a fixed ratio undercounts most where the text changes, as
CJK text does against code (GenericAgent, arXiv:2604.17091, budgets
conservatively for the same reason). A measure of the request itself (evict.lisp
FIT-CHARS-PER-TOKEN) is used as it is."
  (let* ((known (limit-of (read-limits dir) key))
         (latest (json-get known "charsPerToken"))
         (seen (let ((v (json-get known "charsPerTokenSeen"))) (if (json-array-p v) (coerce v 'list) '())))
         (all (remove-if-not (lambda (c) (and (realp c) (> c 0))) (cons latest seen))))
    (and all (reduce #'min all))))

(defun learned-host-policy (dir key)
  (let ((policy (json-get (limit-of (read-limits dir) key) "hostPolicy")))
    (and (or (hash-table-p policy) (json-array-p policy)) policy)))

(defun record-host-policy (dir key policy)
  "Keep the host's POLICY a compaction carried, for a model with a learned window
only (where it is read); written when it changed."
  (when (and key (truthy-p policy))
    (let* ((limits (read-limits dir)) (known (limit-of limits key)))
      (when (and (truthy-p known)
                 (not (let ((was (json-get known "hostPolicy"))) (and was (string= (json-string was) (json-string policy))))))
        (let ((entry (entry-copy known)))
          (setf (gethash "hostPolicy" entry) policy (gethash key limits) entry)
          (write-limits dir limits))))))

(defun effective-window (&rest windows)
  "The smallest window known."
  (let ((known (remove nil (mapcar #'positive-floor windows))))
    (and known (reduce #'min known))))

(defun window-of (model host-name dir)
  "The window for MODEL: the host's (its catalog's, or on omp the provider's own),
capped by a limit an overflow error stated, unless the provider has since
accepted a larger prompt than that limit: then the limit was wrong for this
model (the total with the output, another route of the same model) and is not
kept to. The largest prompt accepted is reported beside it, and never raises
the window past the host's, whose trigger is its own. Whose the window is says
which won."
  (let* ((cw (json-get model "contextWindow"))
         (host (and (realp cw) (> cw 0) cw))
         (entry (limit-of (read-limits dir) (model-key model)))
         (accepted (let ((p (json-get entry "maxPromptTokens"))) (and (realp p) (> p 0) p)))
         (stated (let ((n (json-get entry "contextWindow"))) (and (realp n) (> n 0) n)))
         (learned (and stated (not (and accepted (> accepted stated))) stated))
         (effective (effective-window host learned)))
    (json-object "host" host "learned" learned "accepted" accepted "effective" effective
                 "source" (cond ((null effective) "unknown")
                                ((and learned (= effective learned) (not (and host (= learned host)))) "overflow-error")
                                (t host-name)))))

(defun settled-compaction (&key model dir host display-name models-file used-tokens)
  "Once a run settles (src/compaction.ts): whether keel compacts in the host's
stead (the host's window is above the real one, its last recorded policy
compacts, the context is past the trigger), at what trigger, and the note
that says so."
  (let* ((w (window-of model host dir))
         (host-window (json-get w "host")) (effective (json-get w "effective")))
    (when (and host-window effective (< effective host-window))
      (let ((policy (learned-host-policy dir (model-key model))))
        ;; The host's name is its trigger rule.
        (when (and policy (rule-auto-compacts-p host policy))
          (let ((trigger (trigger-for effective nil nil policy host)))
            (when (and trigger (realp used-tokens) (>= used-tokens trigger))
              (json-object "trigger" trigger
                           "notice" (format nil "keel: ~a holds ~a tokens (an overflow error said so), not the ~a ~a uses; keel compacts at ~a. Set its contextWindow in ~a to make ~a do the same."
                                            (js-string-of (model-key model)) (js-string-of effective) (js-string-of host-window) display-name
                                            (js-string-of trigger) models-file display-name)))))))))
