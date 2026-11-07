;;;; limits.lisp --- a model's real window, learned from overflow errors.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; With the decision src/hooks/window-limits.ts asks for once a run settles.
;;;; omp-vcc takes the window from the host and makes no network call of its
;;;; own; when a provider serves less, the limit its overflow error states
;;;; ("maximum context length is 32768 tokens") is kept per model in omp-vcc-models.json next to the config, with the
;;;; host's compaction policy as the latest compaction for that model carried it,
;;;; so a later session starts from both.

(in-package #:omp-vcc)

(defparameter +limits-file+ "omp-vcc-models.json")

(defun model-key (model)
  "The key the limits file names MODEL by: provider/id, or NIL without both."
  (let ((provider (json-get model "provider")) (id (json-get model "id")))
    (and (truthy-p provider) (truthy-p id) (format nil "~a/~a" (js-string-of provider) (js-string-of id)))))

(defun limits-path (dir) (concatenate 'string (string-right-trim "/" dir) "/" +limits-file+))

(defun read-limits (dir)
  "The limits file's object (an array too, as JSON.parse gives it), or an empty one."
  (let ((parsed (read-json-file (limits-path dir))))
    (if (or (hash-table-p parsed) (json-array-p parsed)) parsed (make-hash-table :test 'equal))))

(defun write-limits (dir limits)
  (ignore-errors (write-text-file (limits-path dir) (format nil "~a~%" (json-pretty-string limits))) t))

(defun limit-of (limits key)
  "LIMITS[KEY], as JavaScript reads a property: an array has none by such a name."
  (and key (hash-table-p limits) (json-get limits key)))

(defun spread-any (value)
  "`{...VALUE}`: an object's keys, an array's or a string's indices, nothing of anything else."
  (cond ((or (hash-table-p value) (json-array-p value)) (spread-object value))
        ((stringp value)
         (let ((object (make-hash-table :test 'equal)))
           (loop for i below (js-length value) do (setf (gethash (format nil "~d" i) object) (js-slice value i (1+ i))))
           object))
        (t (make-hash-table :test 'equal))))

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
      (unless (and (realp known) (<= known window))
        (when (hash-table-p limits)
          (let ((entry (spread-any (json-get limits key))))
            (setf (gethash "contextWindow" entry) window (gethash "source" entry) "overflow-error" (gethash "at" entry) now
                  (gethash key limits) entry)))
        ;; An array keeps no property by that name: JSON.stringify writes it as it was.
        (write-limits dir limits)))))

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
        (let ((entry (spread-any known)))
          (setf (gethash "hostPolicy" entry) policy (gethash key limits) entry)
          (write-limits dir limits))))))

(defun effective-window (&rest windows)
  "The smallest window known."
  (let ((known (remove nil (mapcar #'positive-floor windows))))
    (and known (reduce #'min known))))

(defun window-of (model host-name dir)
  "The window for MODEL: the host's, the learned one, the smaller, and whose it is."
  (let* ((cw (json-get model "contextWindow"))
         (host (and (realp cw) (> cw 0) cw))
         (learned (learned-window dir (model-key model)))
         (effective (effective-window host learned)))
    (json-object "host" host "learned" learned "effective" effective
                 "source" (cond ((null effective) "unknown")
                                ((and learned (= effective learned) (not (and host (= learned host)))) "overflow-error")
                                (t host-name)))))

(defun settled-compaction (input)
  "Once a run settles (src/hooks/window-limits.ts): whether omp-vcc compacts in the host's
stead (the host's window is above the real one, its last recorded policy
compacts, the context is past the trigger), at what trigger, and the note
that says so."
  (let* ((model (json-get input "model"))
         (dir (json-get input "dir"))
         (rule (json-get input "ruleName"))
         (w (window-of model (json-get input "hostName") dir))
         (host (json-get w "host")) (effective (json-get w "effective")))
    (when (and host effective (< effective host))
      (let ((policy (learned-host-policy dir (model-key model))))
        (when (and policy (rule-auto-compacts-p rule policy))
          (let ((trigger (trigger-for effective nil nil policy rule))
                (used (json-get input "usedTokens")))
            (when (and trigger (realp used) (>= used trigger))
              (let ((display (json-get input "displayName")))
                (json-object "trigger" trigger
                             "notice" (format nil "omp-vcc: ~a holds ~a tokens (an overflow error said so), not the ~a ~a uses; omp-vcc compacts at ~a. Set its contextWindow in ~a to make ~a do the same."
                                              (js-string-of (model-key model)) (js-string-of effective) (js-string-of host) display
                                              (js-string-of trigger) (json-get input "modelsFile") display))))))))))
