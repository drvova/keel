;;;; pins.lisp --- pinning and unpinning notes, for vcc_pin and the pin commands.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/pins.ts (pinCallOf, addPin, removePin, listPins) and of
;;;; what src/tools/pin.ts and src/commands/pin.ts make of a call. The notes are
;;;; the pin ops replayed along the branch (compaction.lisp read-pins); a pin or
;;;; unpin is an op the host appends (its appendEntry), so the core answers with
;;;; the op to append and the text to tell, and the TS side appends and tells.

(in-package #:omp-vcc)

(defparameter +max-safe-integer+ 9007199254740992)

(defun js-id (n)
  "An id as JavaScript holds it: an integer past 2^53 is the nearest double."
  (if (and (integerp n) (> (abs n) +max-safe-integer+)) (coerce n 'double-float) n))

(defun format-pin (n)
  "pins.ts formatPin: [ID] TEXT (BY, #AT)."
  (let ((at (json-get n "at")))
    (format nil "[~a] ~a (~a~a)" (js-string-of (js-id (json-get n "id"))) (json-get n "text") (json-get n "by")
            (if at (format nil ", #~a" (js-string-of (js-id at))) ""))))

(defun format-pin-list (notes)
  (if (null notes)
      "No pinned notes."
      (format nil "Pinned notes (kept at the top of every summary):~%~a"
              (join-strings (mapcar (lambda (n) (format nil "- ~a" (format-pin n))) notes) (string #\Newline)))))

(defun pin-entry-p (e)
  "pins.ts isPinEntry: an omp-vcc.pin custom entry whose data is an object (an array is one too)."
  (and (equal (json-get e "type") "custom") (equal (json-get e "customType") +pin-entry-type+)
       (let ((d (json-get e "data"))) (or (json-object-p d) (json-array-p d)))))

(defun next-pin-id (branch)
  "pins.ts nextPinId: one past every id used on this branch, unpinned ones included."
  (let ((max 0))
    (loop for e across branch
          when (and (pin-entry-p e) (js-integer-p (json-get (json-get e "data") "id")))
            do (setf max (max max (json-get (json-get e "data") "id"))))
    ;; Math.max(...) + 1 on doubles: exact below 2^53.
    (let ((next (+ (coerce max 'double-float) 1d0)))
      (if (< (abs next) +max-safe-integer+) (truncate next) next))))

(defun pin-text (raw)
  "One line, clipped: (values TEXT CLIPPED)."
  (let ((flat (js-trim (rx-replace (rx "\\s+") raw " " :all t))))
    (values (js-clip flat +pin-chars+) (> (js-length flat) +pin-chars+))))

(defun pin-id-of (value)
  "pins.ts toPinId: \"3\", \"#3\", \"[3]\", 3 -> 3; NIL for anything else."
  (cond ((realp value) (and (js-integer-p value) value))
        ((stringp value)
         (let ((m (rx-exec (rx "^\\[?#?(\\d+)\\]?$") (js-trim value))))
           (and m (js-id (parse-integer (rx-group m 1))))))))

(defun same-id-p (a b) (and (realp a) (realp b) (= (js-id a) (js-id b))))

(defun counted-messages (entries)
  (count-if (lambda (e) (and (equal (json-get e "type") "message") (let ((m (json-get e "message" :null))) (not (eq m :null)))))
            entries))

(defun add-pin (branch entries raw by)
  "pins.ts addPin: (values DONE TEXT OP)."
  (multiple-value-bind (text clipped) (pin-text raw)
    (when (zerop (length text)) (return-from add-pin (values nil "Nothing to pin: give the note text." nil)))
    (let ((existing (find text (read-pins branch) :key (lambda (n) (json-get n "text")) :test #'string=)))
      (when existing (return-from add-pin (values nil (format nil "Already pinned: ~a." (format-pin existing)) nil))))
    (let* ((counted (counted-messages entries))
           (at (and (plusp counted) (1- counted)))
           (op (json-object "v" 1 "op" "add" "id" (next-pin-id branch) "text" text "by" by "at" at)))
      (values t (format nil "Pinned ~a~a." (format-pin op) (if clipped (format nil " (clipped to ~d chars)" +pin-chars+) "")) op))))

(defun remove-pin (branch value)
  "pins.ts removePin: (values DONE TEXT OP)."
  (let* ((id (pin-id-of value))
         (notes (read-pins branch))
         (note (and id (find id notes :key (lambda (n) (json-get n "id")) :test #'same-id-p))))
    (if note
        (values t (format nil "Unpinned ~a." (format-pin note)) (json-object "v" 1 "op" "remove" "id" (json-get note "id")))
        (values nil (format nil "No pinned note ~a. ~a"
                            (if id (format nil "[~a]" (js-string-of id)) (json-string value))
                            (format-pin-list notes))
                nil))))

(defun lower-first (text)
  (if (plusp (length text)) (concatenate 'string (string-downcase (subseq text 0 1)) (subseq text 1)) text))

(defun run-pin (input)
  "One vcc_pin call or /…-pin, /…-unpin command: (values DONE TEXT OP SEVERITY AGENT-NOTE)."
  (let* ((call (json-get input "call"))
         (branch (coerce (json-get input "branch" #()) 'vector))
         (entries (coerce (json-get input "entries" branch) 'vector)))
    (if (equal (json-get call "surface") "tool")
        ;; tools/pin.ts executePin.
        (let* ((params (json-get call "params"))
               (raw-note (json-get params "note"))
               (note (and (stringp raw-note) (not (unset-p raw-note)) raw-note))
               (unpin (let ((u (json-get params "unpin"))) (and (not (unset-p u)) u))))
          (cond ((and note unpin) (values nil "Send note or unpin, not both, in one call."))
                (note (add-pin branch entries note "agent"))
                (unpin (remove-pin branch unpin))
                (t (values nil (format-pin-list (read-pins branch))))))
        ;; commands/pin.ts.
        (let ((args (let ((a (json-get call "args"))) (if (stringp a) a ""))))
          (if (equal (json-get call "name") "unpin")
              (multiple-value-bind (done text op) (remove-pin branch (js-trim args))
                (values done text op (if done "info" "warning")
                        (and done (format nil "The user ~a It no longer holds." (lower-first text)))))
              (if (zerop (length (js-trim args)))
                  (values nil (format-pin-list (read-pins branch)))
                  (multiple-value-bind (done text op) (add-pin branch entries args "user")
                    (values done text op (if done "info" "warning")
                            (and done (format nil "The user ~a It stays at the top of every summary." (lower-first text)))))))))))
