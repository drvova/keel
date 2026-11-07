;;;; pins.lisp --- pinning and unpinning notes, for vcc_pin and the pin commands.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; What a vcc_pin call (src/tools/pin.ts) or a pin command (src/commands/pin.ts)
;;;; does. The notes are the pin ops replayed along the branch (READ-PINS); a pin
;;;; or unpin is an op the host appends (its appendEntry), so the core answers
;;;; with the op to append and the text to tell, and the TS side
;;;; (src/core/pins.ts) appends and tells.

(in-package #:omp-vcc)

(defun js-id (n)
  "An id as JavaScript holds it: an integer past 2^53 is the nearest double."
  (if (and (integerp n) (> (abs n) +double-exact+)) (coerce n 'double-float) n))

(defun format-pin (n)
  "A note as it is shown: [ID] TEXT (BY, #AT)."
  (let ((at (json-get n "at")))
    (format nil "[~a] ~a (~a~a)" (js-string-of (js-id (json-get n "id"))) (json-get n "text") (json-get n "by")
            (if at (format nil ", #~a" (js-string-of (js-id at))) ""))))

(defun format-pin-list (notes)
  (if (null notes)
      "No pinned notes."
      (format nil "Pinned notes (kept at the top of every summary):~%~a"
              (join-strings (mapcar (lambda (n) (format nil "- ~a" (format-pin n))) notes) (string #\Newline)))))

(defun pin-entry-p (e)
  "A pin or unpin entry: omp-vcc's custom entry, its data an object (an array is one to JavaScript too)."
  (and (equal (json-get e "type") "custom") (equal (json-get e "customType") +pin-entry-type+)
       (let ((d (json-get e "data"))) (or (json-object-p d) (json-array-p d)))))

(defun read-pins (branch)
  "The notes pinned on BRANCH since its last /clear, oldest first, as JSON: each
pin and unpin replayed along it, so a branch keeps the pins made on it."
  (let ((notes (make-hash-table)))
    (loop for i from (1+ (last-reset-index branch)) below (length branch)
          for e = (aref branch i)
          do (let ((op (json-get e "data")))
               (when (and (pin-entry-p e) (json-object-p op) (js-integer-p (json-get op "id")))
                 (let ((id (as-integer (json-get op "id"))) (text (json-get op "text")))
                   (cond ((and (equal (json-get op "op") "add") (stringp text) (plusp (length (js-trim text))))
                          (setf (gethash id notes)
                                (json-object "id" id "text" text "by" (if (equal (json-get op "by") "agent") "agent" "user")
                                             "at" (and (js-integer-p (json-get op "at")) (as-integer (json-get op "at"))))))
                         ((equal (json-get op "op") "remove") (remhash id notes)))))))
    (let ((ids (sort (loop for k being the hash-keys of notes collect k) #'<)))
      (mapcar (lambda (id) (gethash id notes)) ids))))

(defun next-pin-id (branch)
  "The next note's id: one past every id used on this branch, unpinned ones included."
  (let ((max 0))
    (loop for e across branch
          when (and (pin-entry-p e) (js-integer-p (json-get (json-get e "data") "id")))
            do (setf max (max max (json-get (json-get e "data") "id"))))
    ;; Math.max(...) + 1 on doubles: exact below 2^53.
    (let ((next (+ (coerce max 'double-float) 1d0)))
      (if (< (abs next) +double-exact+) (truncate next) next))))

(defun pin-text (raw)
  "One line, clipped: (values TEXT CLIPPED)."
  (let ((flat (js-trim (rx-replace (rx "\\s+") raw " " :all t))))
    (values (js-clip flat +pin-chars+) (> (js-length flat) +pin-chars+))))

(defun pin-id-of (value)
  "A note id as the agent or the user writes it: \"3\", \"#3\", \"[3]\", 3 -> 3; NIL for anything else."
  (cond ((realp value) (and (js-integer-p value) value))
        ((stringp value)
         (let ((m (rx-exec (rx "^\\[?#?(\\d+)\\]?$") (js-trim value))))
           (and m (js-id (parse-integer (rx-group m 1))))))))

(defun same-id-p (a b) (and (realp a) (realp b) (= (js-id a) (js-id b))))

(defun add-pin (branch entries raw by)
  "Pin RAW by BY, one line and clipped, unless it is empty or pinned already: (values DONE TEXT OP)."
  (multiple-value-bind (text clipped) (pin-text raw)
    (when (zerop (length text)) (return-from add-pin (values nil "Nothing to pin: give the note text." nil)))
    (let ((existing (find text (read-pins branch) :key (lambda (n) (json-get n "text")) :test #'string=)))
      (when existing (return-from add-pin (values nil (format nil "Already pinned: ~a." (format-pin existing)) nil))))
    (let* ((counted (count-if #'counted-entry-p entries))
           (at (and (plusp counted) (1- counted)))
           (op (json-object "v" 1 "op" "add" "id" (next-pin-id branch) "text" text "by" by "at" at)))
      (values t (format nil "Pinned ~a~a." (format-pin op) (if clipped (format nil " (clipped to ~d chars)" +pin-chars+) "")) op))))

(defun remove-pin (branch value)
  "Unpin the note VALUE names, or list the notes when none does: (values DONE TEXT OP)."
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
        ;; The tool: a note, an unpin, or the list; both at once is refused.
        (let ((pin (pin-call-of (json-get call "params"))))
          (cond ((eq pin :both) (values nil "Send note or unpin, not both, in one call."))
                ((eq pin :list) (values nil (format-pin-list (read-pins branch))))
                ((eq (first pin) :note) (add-pin branch entries (second pin) "agent"))
                (t (remove-pin branch (second pin)))))
        ;; The commands: /…-unpin ID, /…-pin TEXT, or the list.
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
