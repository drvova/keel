;;;; pins.lisp --- pinning and unpinning notes, for keel_pin and the pin commands.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; What a keel_pin call or a pin command does. The notes are the pin ops
;;;; replayed along the branch (READ-PINS); a pin or unpin is an op the host
;;;; appends (its appendEntry), so the core answers with the op to append and
;;;; the text to tell (surface.lisp words them as effects).

(in-package #:keel)

(defun js-id (n)
  "An id as JavaScript holds it: an integer past 2^53 is the nearest double."
  (if (and (integerp n) (> (abs n) +double-exact+)) (coerce n 'double-float) n))

(defun format-pin (n)
  "A note as it is shown, in a listing and in [Pinned Notes]: [ID] NAME: TEXT (BY, #AT), NAME only for a named one."
  (let ((at (let ((a (json-get n "at"))) (and (not (eq a :null)) a))))
    (format nil "[~a] ~@[~a: ~]~a (~a~a)" (js-string-of (js-id (json-get n "id"))) (pin-name n) (json-get n "text") (json-get n "by")
            (cond (at (format nil ", #~a" (js-string-of (js-id at))))
                  ((stringp (json-get n "from")) (format nil ", from session ~a" (json-get n "from")))
                  (t "")))))

(defun pin-name (n) (let ((name (json-get n "name"))) (and (stringp name) name)))

(defun pin-name-of (value)
  "A note's name as given: trimmed and lowercased, letters, digits and . _ - only,
starting with a letter or digit, up to +PIN-NAME-CHARS+; NIL for anything else."
  (when (stringp value)
    (let ((name (string-downcase (js-trim value))))
      (and (<= 1 (length name) +pin-name-chars+)
           (rx-test (rx "^[a-z0-9][a-z0-9._-]*$") name)
           name))))

(defun format-pin-list (notes)
  (if (null notes)
      "No pinned notes."
      (format nil "Pinned notes (kept at the top of every summary):~%~a"
              (join-strings (mapcar (lambda (n) (format nil "- ~a" (format-pin n))) notes) (string #\Newline)))))

(defun pin-entry-p (e)
  "A pin or unpin entry: keel's custom entry, its data an object (an array is one to JavaScript too)."
  (and (equal (json-get e "type") "custom") (pin-entry-type-p (json-get e "customType"))
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
                          (let ((name (pin-name-of (json-get op "name"))))
                            ;; A name defined again replaces the note it named.
                            (when name
                              (loop for k being the hash-keys of notes using (hash-value n)
                                    when (equal (pin-name n) name) do (remhash k notes)))
                            (setf (gethash id notes)
                                  (let ((note (json-object "id" id "text" text "by" (if (equal (json-get op "by") "agent") "agent" "user")
                                                           "at" (and (js-integer-p (json-get op "at")) (as-integer (json-get op "at"))))))
                                    (when name (setf (gethash "name" note) name))
                                    (when (stringp (json-get op "from")) (setf (gethash "from" note) (json-get op "from")))
                                    note))))
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

(defun add-pin (branch entries raw by &optional name)
  "Pin RAW by BY, one line and clipped, under NAME when given, unless it is empty or
pinned already: (values DONE TEXT OP). A NAME already pinned is defined again:
the new note replaces the one it named."
  (multiple-value-bind (text clipped) (pin-text raw)
    (when (zerop (length text)) (return-from add-pin (values nil "Nothing to pin: give the note text." nil)))
    (let* ((notes (read-pins branch))
           (named (and name (find name notes :key #'pin-name :test #'equal)))
           (existing (find-if (lambda (n) (and (string= (json-get n "text") text) (equal (pin-name n) name))) notes)))
      (when existing (return-from add-pin (values nil (format nil "Already pinned: ~a." (format-pin existing)) nil)))
      (when (and named (equal by "agent") (equal (json-get named "by") "user"))
        (return-from add-pin (values nil (users-note named "defined again") nil)))
      (let* ((counted (count-if #'counted-entry-p entries))
             (at (and (plusp counted) (1- counted)))
             (op (json-object "v" 1 "op" "add" "id" (next-pin-id branch) "text" text "by" by "at" at)))
        (when name (setf (gethash "name" op) name))
        (values t (format nil "~:[Pinned~;Redefined~] ~a~a.~@[ It replaces ~a.~]" named (format-pin op)
                          (if clipped (format nil " (clipped to ~d chars)" +pin-chars+) "")
                          (and named (format-pin named)))
                op)))))

(defun users-note (note what)
  "Why the agent may not change NOTE, one the user pinned: it stays until the user changes it."
  (format nil "~a is the user's note and stays: only the user has it ~a (/…-pin, /…-unpin). Tell the user what should change, or pin yours under another name."
          (format-pin note) what))

(defun remove-pin (branch value &optional agent)
  "Unpin the note VALUE names, or list the notes when none does: (values DONE TEXT OP).
AGENT: the agent's call, which leaves a note the user pinned as it is."
  (let* ((id (pin-id-of value))
         (notes (read-pins branch))
         (note (if id
                   (find id notes :key (lambda (n) (json-get n "id")) :test #'same-id-p)
                   (let ((name (pin-name-of value))) (and name (find name notes :key #'pin-name :test #'equal))))))
    (cond
      ((and note agent (equal (json-get note "by") "user"))
       (values nil (users-note note "unpinned") nil))
      (note
        (values t (format nil "Unpinned ~a." (format-pin note)) (json-object "v" 1 "op" "remove" "id" (json-get note "id"))))
      (t
        (values nil (format nil "No pinned note ~a. ~a"
                            (if id (format nil "[~a]" (js-string-of id)) (json-string value))
                            (format-pin-list notes))
                nil)))))

(defun lower-first (text)
  (if (plusp (length text)) (concatenate 'string (string-downcase (subseq text 0 1)) (subseq text 1)) text))

(defun file-branch (path)
  "The entries on PATH's active branch, in file order."
  (let* ((entries (jsonl-values path)) (ids (active-branch-ids entries)))
    (coerce (remove-if-not (lambda (e) (and (hash-table-p e) (gethash (json-get e "id") ids))) entries) 'vector)))

(defun carried-pins (entries files)
  "The named notes a new session starts with: the user's of the project's last
session before it (FILES, newest first), as pin ops of this one, marked with
the session they came from. A note is named to be kept; an unnamed one stays
with its session. The agent's stay with theirs too: a note the agent pinned
may hold what a page or a file told it, and an instruction carried into every
later session is how an injection persists (Context Language Models, section
6); the agent finds them with keel_recall sessions and pins again what still
holds. Nothing for a session that has a message or a pin already (resumed,
forked, or carried into once)."
  (unless (or (some #'counted-entry-p entries) (some #'pin-entry-p entries) (null files))
    (let* ((previous (first files))
           (from (let ((id (json-get (read-header previous) "id"))) (if (stringp id) (subseq id 0 (min 8 (length id))) "")))
           (id 0))
      (loop for n in (read-pins (file-branch previous))
            when (and (pin-name n) (equal (json-get n "by") "user"))
              collect (let ((op (json-object "v" 1 "op" "add" "id" (incf id) "name" (pin-name n) "text" (json-get n "text")
                                             "by" (json-get n "by") "at" :null)))
                        (setf (gethash "from" op) from)
                        op)))))

(defun run-pin (input)
  "One keel_pin call or /…-pin, /…-unpin command: (values DONE TEXT OP SEVERITY AGENT-NOTE).
A carry (a session starting) answers with the ops instead: (values T TEXT OPS)."
  (let* ((call (json-get input "call"))
         (branch (coerce (json-get input "branch" #()) 'vector))
         (entries (coerce (json-get input "entries" branch) 'vector)))
    (when (equal (json-get call "surface") "carry")
      (let ((ops (carried-pins entries (coerce (json-get call "files" #()) 'list))))
        (return-from run-pin
          (values (and ops t) (and ops (format nil "Carried from the last session: ~{~a~^; ~}." (mapcar #'format-pin ops))) (coerce ops 'vector)))))
    (if (equal (json-get call "surface") "tool")
        ;; The tool: a note, an unpin, or the list; both at once is refused.
        (let ((pin (pin-call-of (json-get call "params"))))
          (cond ((eq pin :both) (values nil "Send note or unpin, not both, in one call."))
                ((eq pin :list) (values nil (format-pin-list (read-pins branch))))
                ((eq (first pin) :note)
                 (if (and (third pin) (not (pin-name-of (third pin))))
                     (values nil (format nil "Not a name: ~a. A name is letters, digits and . _ - (up to ~d chars), e.g. auth-plan." (json-string (third pin)) +pin-name-chars+))
                     (add-pin branch entries (second pin) "agent" (pin-name-of (third pin)))))
                (t (remove-pin branch (second pin) t))))
        ;; The commands: /…-unpin ID, /…-pin TEXT, or the list.
        (let ((args (let ((a (json-get call "args"))) (if (stringp a) a ""))))
          (if (equal (json-get call "name") "unpin")
              (multiple-value-bind (done text op) (remove-pin branch (js-trim args))
                (values done text op (if done "info" "warning")
                        (and done (format nil "The user ~a It no longer holds." (lower-first text)))))
              (if (zerop (length (js-trim args)))
                  (values nil (format-pin-list (read-pins branch)))
                  (multiple-value-bind (done text op) (multiple-value-bind (name rest) (command-pin-name args) (add-pin branch entries rest "user" name))
                    (values done text op (if done "info" "warning")
                            (and done (format nil "The user ~a It stays at the top of every summary." (lower-first text)))))))))))

(defun command-pin-name (args)
  "/…-pin's text: a leading name:NAME names the note. (values NAME TEXT)."
  (let ((m (rx-exec (rx "^\\s*name:(\\S+)\\s+([\\s\\S]*)$") args)))
    (if (and m (pin-name-of (rx-group m 1)))
        (values (pin-name-of (rx-group m 1)) (rx-group m 2))
        (values nil args))))

(defun pin-call-of (args)
  "A keel_pin call as the tool reads it: (:note TEXT NAME), (:unpin VALUE), :both or :list."
  (let* ((raw (json-get args "note"))
         (note (and (stringp raw) (not (unset-p raw)) raw))
         (name (let ((n (json-get args "name"))) (and (stringp n) (plusp (length (js-trim n))) n)))
         (unpin (let ((u (json-get args "unpin"))) (if (unset-p u) nil u))))
    (cond ((and note unpin) :both)
          (note (list :note note name))
          (unpin (list :unpin unpin))
          (t :list))))
