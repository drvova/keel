;;;; regex.lisp --- JavaScript's regular expressions, as recall's search uses them.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; search-entries.ts compiles a query with `new RegExp(pattern, "i")`: the
;;;; non-unicode dialect with Annex B's leniencies, case-insensitive. This is
;;;; that dialect, held to it on three things a search's answer depends on:
;;;;
;;;;   * what is a syntax error, since safeRegex then searches for the
;;;;     pattern's text literally instead;
;;;;   * matching on UTF-16 code units, as a non-unicode regex does (`.`
;;;;     matches half of an emoji), with positions in code units;
;;;;   * case folding by the spec's Canonicalize: a character's uppercase when
;;;;     that is one code unit and does not take a non-ASCII character to ASCII.
;;;;
;;;; A construct whose meaning here is not certain to be JavaScript's (named
;;;; groups, legacy octal escapes, a back-reference past the group count, a
;;;; capture inside a look-behind) is refused with REGEX-UNSUPPORTED, and the
;;;; caller leaves the query to the TS search: an answer from the core is the
;;;; TS answer or none. tests/lisp-regex.test.ts compares test, search and
;;;; global match counts with JavaScript's own over generated patterns.
;;;;
;;;; The matcher backtracks, as JavaScript's does; a single-unit atom repeated
;;;; with no captures is matched in a loop rather than by recursion, and a
;;;; deadline (*REGEX-DEADLINE*) is checked as it runs.

(in-package #:omp-vcc)

(define-condition regex-syntax-error (error) ((detail :initarg :detail :reader regex-detail))
  (:report (lambda (c s) (format s "regex syntax error: ~a" (regex-detail c)))))
(define-condition regex-unsupported (error) ((detail :initarg :detail :reader regex-detail))
  (:report (lambda (c s) (format s "regex construct left to the TS search: ~a" (regex-detail c)))))
(define-condition regex-aborted (error) ())

(deftype units () '(simple-array (unsigned-byte 16) (*)))

(defun string-units (string)
  "STRING as its UTF-16 code units."
  (let ((out (make-array (js-length string) :element-type '(unsigned-byte 16))) (i 0))
    (declare (fixnum i))
    (loop for c across string
          for code = (char-code c)
          do (if (> code #xFFFF)
                 (let ((v (- code #x10000)))
                   (setf (aref out i) (+ #xD800 (ash v -10))
                         (aref out (1+ i)) (+ #xDC00 (logand v #x3FF)))
                   (incf i 2))
                 (progn (setf (aref out i) code) (incf i))))
    out))

;;; --- parsing -----------------------------------------------------------------
;;;
;;; The tree: (:char U) (:any) (:class BITS) (:start) (:end) (:boundary NEGATE)
;;; (:group I NODE) (:seq NODES) (:alt NODES) (:repeat MIN MAX GREEDY NODE)
;;; (:look AHEAD NEGATE NODE) (:backref I) — BITS a 65536-bit vector of the
;;; units a class matches, case folding applied.

(defun syntax-error (detail) (error 'regex-syntax-error :detail detail))
(defun unsupported (detail) (error 'regex-unsupported :detail detail))

(defun word-unit-p (u)
  (or (<= 48 u 57) (<= 65 u 90) (<= 97 u 122) (= u 95)))

(defun space-unit-p (u) (js-whitespace-p (code-char u)))

(defun line-terminator-p (u) (member u '(10 13 #x2028 #x2029)))

(defvar *ignore-case* t "The /i flag, read while a pattern is parsed and compiled.")
(defvar *multiline* nil "The /m flag, read while a pattern is compiled.")

(defun class-bits (items negate)
  "The units a class of ITEMS matches; under /i a unit matches when any unit
/i makes equal to it is in the class."
  (let ((raw (make-array 65536 :element-type 'bit :initial-element 0)))
    (dolist (item items)
      (ecase (first item)
        (:range (loop for u from (second item) to (third item) do (setf (sbit raw u) 1)))
        (:set (let ((test (ecase (second item)
                            (:digit (lambda (u) (<= 48 u 57))) (:not-digit (lambda (u) (not (<= 48 u 57))))
                            (:word #'word-unit-p) (:not-word (lambda (u) (not (word-unit-p u))))
                            (:space #'space-unit-p) (:not-space (lambda (u) (not (space-unit-p u)))))))
                (dotimes (u 65536) (when (funcall test u) (setf (sbit raw u) 1)))))))
    (let ((bits (make-array 65536 :element-type 'bit :initial-element 0)))
      (dotimes (u 65536)
        (let ((in (or (= 1 (sbit raw u))
                      (and *ignore-case* (some (lambda (v) (= 1 (sbit raw v))) (aref +same-case+ u))))))
          (setf (sbit bits u) (if (eq (not in) (not negate)) 0 1))))
      bits)))

(defun count-groups (p)
  "The capturing groups of the pattern units P, for telling a back-reference
from an escape; a named group is refused."
  (let ((n 0) (i 0) (len (length p)) (in-class nil))
    (loop while (< i len)
          do (let ((u (aref p i)))
               (cond ((= u 92) (incf i))           ; \
                     (in-class (when (= u 93) (setf in-class nil)))
                     ((= u 91) (setf in-class t))  ; [
                     ((= u 40)                     ; (
                      (if (and (< (1+ i) len) (= (aref p (1+ i)) 63)) ; (?
                          (when (and (< (+ i 2) len) (= (aref p (+ i 2)) 60) ; (?<
                                     (< (+ i 3) len) (not (member (aref p (+ i 3)) '(61 33))))
                            (unsupported "named group"))
                          (incf n)))))
             (incf i))
    n))

(defun parse-regex (p)
  "The tree of the pattern units P, and its group count."
  (let ((pos 0) (len (length p)) (groups (count-groups p)) (group-index 0))
    (labels ((peek (&optional (k 0)) (and (< (+ pos k) len) (aref p (+ pos k))))
             (at (u &optional (k 0)) (eql (peek k) u))
             (digit-at (k) (let ((u (peek k))) (and u (<= 48 u 57))))
             (hex-value (u) (and u (digit-char-p (code-char u) 16)))
             (braced-quantifier ()
               ;; {n} {n,} {n,m} at POS, as (values MIN MAX LENGTH), or NIL.
               (when (at 123)
                 (let ((i (1+ pos)) (min 0) (max nil) (seen nil))
                   (loop while (and (< i len) (<= 48 (aref p i) 57))
                         do (setf min (min (+ (* min 10) (- (aref p i) 48)) most-positive-fixnum) seen t) (incf i))
                   (when seen
                     (cond ((and (< i len) (= (aref p i) 125)) (values min min (- (1+ i) pos)))
                           ((and (< i len) (= (aref p i) 44))
                            (incf i)
                            (let ((mseen nil) (m 0))
                              (loop while (and (< i len) (<= 48 (aref p i) 57))
                                    do (setf m (min (+ (* m 10) (- (aref p i) 48)) most-positive-fixnum) mseen t) (incf i))
                              (when (and (< i len) (= (aref p i) 125))
                                (setf max (and mseen m))
                                (values min max (- (1+ i) pos) t)))))))))
             (quantifier-at-p ()
               (or (member (peek) '(42 43 63)) (braced-quantifier)))
             (disjunction ()
               (let ((alts (list (alternative))))
                 (loop while (at 124) do (incf pos) (push (alternative) alts))
                 (if (rest alts) (list :alt (nreverse alts)) (first alts))))
             (alternative ()
               (let ((terms '()))
                 (loop while (and (< pos len) (not (at 124)) (not (at 41)))
                       do (push (term) terms))
                 (list :seq (nreverse terms))))
             (assertion (node)
               (when (quantifier-at-p) (syntax-error "nothing to repeat"))
               node)
             (term ()
               (let ((u (peek)))
                 (cond ((= u 94) (incf pos) (assertion '(:start)))
                       ((= u 36) (incf pos) (assertion '(:end)))
                       ((and (= u 92) (member (peek 1) '(98 66)))
                        (let ((negate (= (peek 1) 66)))
                          (incf pos 2)
                          (assertion (list :boundary negate))))
                       ((and (= u 40) (at 63 1) (at 60 2) (member (peek 3) '(61 33)))
                        ;; A look-behind is not quantifiable; one with a capture is matched
                        ;; backwards in JavaScript, which changes what it captures.
                        (let ((negate (= (peek 3) 33)) (before group-index))
                          (incf pos 4)
                          (let ((node (disjunction)))
                            (unless (at 41) (syntax-error "unterminated group"))
                            (incf pos)
                            (when (/= before group-index) (unsupported "capture in a look-behind"))
                            (when (tree-has node :backref) (unsupported "back-reference in a look-behind"))
                            (when (quantifier-at-p) (syntax-error "nothing to repeat"))
                            (list :look nil negate node))))
                       ((member u '(42 43 63)) (syntax-error "nothing to repeat"))
                       ((and (= u 123) (braced-quantifier)) (syntax-error "nothing to repeat"))
                       ((= u 41) (syntax-error "unmatched )"))
                       (t (quantified (extended-atom))))))
             (quantified (node)
               (multiple-value-bind (min max length) (braced-quantifier)
                 (let ((q (cond (min (incf pos length) (when (and max (> min max)) (syntax-error "numbers out of order")) (list min max))
                                ((at 42) (incf pos) (list 0 nil))
                                ((at 43) (incf pos) (list 1 nil))
                                ((at 63) (incf pos) (list 0 1)))))
                   (if q
                       (let ((greedy (if (at 63) (progn (incf pos) nil) t)))
                         (list :repeat (first q) (second q) greedy node))
                       node))))
             (extended-atom ()
               (let ((u (peek)))
                 (incf pos)
                 (case u
                   (46 '(:any))
                   (91 (char-class))
                   (40 (cond ((and (at 63) (member (peek 1) '(61 33)))
                              (let ((negate (= (peek 1) 33)))
                                (incf pos 2)
                                (prog1 (list :look t negate (disjunction)) (close-group))))
                             ((and (at 63) (at 58 1))
                              (incf pos 2)
                              (prog1 (disjunction) (close-group)))
                             ((at 63) (syntax-error "invalid group"))
                             (t (let ((index (incf group-index)))
                                  (prog1 (list :group index (disjunction)) (close-group))))))
                   (92 (atom-escape))
                   (t (list :char u)))))
             (close-group ()
               (unless (at 41) (syntax-error "unterminated group"))
               (incf pos))
             (control-escape (u)
               (case u (102 12) (110 10) (114 13) (116 9) (118 11)))
             (hex-escape (digits)
               ;; \xHH or \uHHHH, or NIL (then the letter stands for itself).
               (when (loop for k below digits always (hex-value (peek k)))
                 (prog1 (loop with v = 0 for k below digits do (setf v (+ (* v 16) (hex-value (peek k)))) finally (return v))
                   (incf pos digits))))
             (atom-escape ()
               (let ((u (peek)))
                 (unless u (syntax-error "\\ at end of pattern"))
                 (cond ((member u '(100 68 119 87 115 83))
                        (incf pos)
                        (list :class (class-bits (list (list :set (class-escape-set u))) nil)))
                       ((control-escape u) (incf pos) (list :char (control-escape u)))
                       ((= u 99)                  ; \c
                        (let ((l (peek 1)))
                          (if (and l (or (<= 65 l 90) (<= 97 l 122)))
                              (progn (incf pos 2) (list :char (mod l 32)))
                              (list :char 92))))  ; a lone backslash; the c is read next
                       ((= u 48)
                        (when (digit-at 1) (unsupported "octal escape"))
                        (incf pos) (list :char 0))
                       ((<= 49 u 57)
                        (let ((n 0) (start pos))
                          (loop while (digit-at 0) do (setf n (+ (* n 10) (- (peek) 48))) (incf pos))
                          (if (<= n groups)
                              (list :backref n)
                              (progn (setf pos start) (unsupported "octal or identity escape")))))
                       ((= u 120) (incf pos) (list :char (or (hex-escape 2) 120)))
                       ((= u 117) (incf pos) (list :char (or (hex-escape 4) 117)))
                       (t (incf pos) (list :char u)))))
             (class-escape-set (u)
               (ecase u (100 :digit) (68 :not-digit) (119 :word) (87 :not-word) (115 :space) (83 :not-space)))
             (class-atom ()
               ;; One class atom: (:range U U) or (:set NAME).
               (let ((u (peek)))
                 (unless u (syntax-error "unterminated character class"))
                 (incf pos)
                 (if (/= u 92)
                     (list :range u u)
                     (let ((e (peek)))
                       (unless e (syntax-error "\\ at end of pattern"))
                       (cond ((member e '(100 68 119 87 115 83)) (incf pos) (list :set (class-escape-set e)))
                             ((= e 98) (incf pos) (list :range 8 8))
                             ((control-escape e) (incf pos) (let ((c (control-escape e))) (list :range c c)))
                             ((= e 99)
                              (let ((l (peek 1)))
                                (if (and l (or (<= 65 l 90) (<= 97 l 122) (<= 48 l 57) (= l 95)))
                                    (progn (incf pos 2) (list :range (mod l 32) (mod l 32)))
                                    (list :range 92 92))))
                             ((<= 48 e 57) (unsupported "octal escape in a class"))
                             ((= e 120) (incf pos) (let ((v (or (hex-escape 2) 120))) (list :range v v)))
                             ((= e 117) (incf pos) (let ((v (or (hex-escape 4) 117))) (list :range v v)))
                             (t (incf pos) (list :range e e)))))))
             (char-class ()
               (let ((negate (when (at 94) (incf pos) t)) (items '()))
                 (loop (unless (< pos len) (syntax-error "unterminated character class"))
                       (when (at 93) (incf pos) (return))
                       (let ((a (class-atom)))
                         (if (and (at 45) (peek 1) (not (at 93 1)))
                             (progn
                               (incf pos)
                               (let ((b (class-atom)))
                                 (if (or (eq (first a) :set) (eq (first b) :set))
                                     (progn (push a items) (push (list :range 45 45) items) (push b items))
                                     (if (> (second a) (second b))
                                         (syntax-error "range out of order in character class")
                                         (push (list :range (second a) (second b)) items)))))
                             (push a items))))
                 (list :class (class-bits items negate)))))
      (let ((tree (disjunction)))
        (when (< pos len) (syntax-error "unmatched )"))
        (values tree groups)))))

(defun tree-has (tree kind)
  "True when a node of KIND is anywhere in TREE."
  (and (consp tree)
       (or (eq (first tree) kind)
           (some (lambda (x) (tree-has x kind)) tree))))

(defun node-width (node)
  "The fewest and most units NODE can match, as (values MIN MAX), MAX NIL for no bound."
  (ecase (first node)
    ((:char :any :class) (values 1 1))
    ((:start :end :boundary :look) (values 0 0))
    (:backref (values 0 nil))
    (:group (node-width (third node)))
    (:seq (let ((lo 0) (hi 0))
            (dolist (n (second node) (values lo hi))
              (multiple-value-bind (a b) (node-width n)
                (incf lo a)
                (setf hi (and hi b (+ hi b)))))))
    (:alt (let ((lo nil) (hi 0))
            (dolist (n (second node) (values (or lo 0) hi))
              (multiple-value-bind (a b) (node-width n)
                (setf lo (if lo (min lo a) a)
                      hi (and hi b (max hi b)))))))
    (:repeat (destructuring-bind (min max greedy body) (rest node)
               (declare (ignore greedy))
               (multiple-value-bind (a b) (node-width body)
                 (values (* min a) (and max b (* max b))))))))

(defun groups-in (node)
  "The capture indices inside NODE."
  (cond ((not (consp node)) '())
        ((eq (first node) :group) (cons (second node) (groups-in (third node))))
        ((member (first node) '(:seq :alt)) (mapcan #'groups-in (copy-list (second node))))
        ((eq (first node) :repeat) (groups-in (fifth node)))
        ((eq (first node) :look) (groups-in (fourth node)))
        (t '())))

;;; --- matching ----------------------------------------------------------------

(defvar *input* (make-array 0 :element-type '(unsigned-byte 16)))
(defvar *captures* (make-array 0 :initial-element nil))
(defvar *regex-deadline* nil "Internal real time past which a match is abandoned, or NIL.")
(defvar *steps* 0)

(declaim (type units *input*) (type fixnum *steps*))

(defun tick ()
  (when (and *regex-deadline* (zerop (logand (incf *steps*) #xFFFF))
             (> (get-internal-real-time) *regex-deadline*))
    (error 'regex-aborted)))

(defun unit-test-of (node)
  "A predicate on one unit for a node that matches exactly one, or NIL."
  (case (first node)
    (:char (if *ignore-case*
               (let ((c (canon (second node)))) (lambda (u) (= (canon u) c)))
               (let ((c (second node))) (lambda (u) (= u c)))))
    (:any (lambda (u) (not (line-terminator-p u))))
    (:class (let ((bits (second node))) (lambda (u) (= 1 (sbit bits u)))))))

(defun compile-node (node k)
  "A matcher for NODE followed by the matcher K: a function of a position that
is true when NODE matches there and K matches where it ends."
  (ecase (first node)
    ((:char :any :class)
     (let ((test (unit-test-of node)))
       (lambda (pos)
         (declare (fixnum pos))
         (and (< pos (length *input*)) (funcall test (aref *input* pos)) (funcall k (1+ pos))))))
    (:start (if *multiline*
                (lambda (pos) (and (or (zerop pos) (line-terminator-p (aref *input* (1- pos)))) (funcall k pos)))
                (lambda (pos) (and (zerop pos) (funcall k pos)))))
    (:end (if *multiline*
              (lambda (pos) (and (or (= pos (length *input*)) (line-terminator-p (aref *input* pos))) (funcall k pos)))
              (lambda (pos) (and (= pos (length *input*)) (funcall k pos)))))
    (:boundary
     (let ((negate (second node)))
       (lambda (pos)
         (let ((a (and (> pos 0) (word-unit-p (aref *input* (1- pos)))))
               (b (and (< pos (length *input*)) (word-unit-p (aref *input* pos)))))
           (and (if negate (eq a b) (not (eq a b))) (funcall k pos))))))
    (:seq (reduce (lambda (n next) (compile-node n next)) (second node) :from-end t :initial-value k))
    (:alt (let ((alts (mapcar (lambda (n) (compile-node n k)) (second node))))
            (lambda (pos) (tick) (some (lambda (m) (funcall m pos)) alts))))
    (:group
     (let* ((i (second node)) (start-cell (list nil))
            (inner (compile-node (third node)
                                 (lambda (p)
                                   (let ((os (aref *captures* (* 2 i))) (oe (aref *captures* (1+ (* 2 i)))))
                                     (setf (aref *captures* (* 2 i)) (car start-cell) (aref *captures* (1+ (* 2 i))) p)
                                     (or (funcall k p)
                                         (progn (setf (aref *captures* (* 2 i)) os (aref *captures* (1+ (* 2 i))) oe) nil)))))))
       (lambda (pos)
         (let ((saved (car start-cell)))
           (setf (car start-cell) pos)
           (prog1 (funcall inner pos) (setf (car start-cell) saved))))))
    (:backref
     (let ((i (second node)) (fold *ignore-case*))
       (lambda (pos)
         (let ((s (aref *captures* (* 2 i))) (e (aref *captures* (1+ (* 2 i)))))
           (if (or (null s) (null e))
               (funcall k pos)
               (let ((n (- e s)))
                 (and (<= (+ pos n) (length *input*))
                      (loop for j below n
                            for a = (aref *input* (+ s j)) and b = (aref *input* (+ pos j))
                            always (if fold (= (canon a) (canon b)) (= a b)))
                      (funcall k (+ pos n)))))))))
    (:look
     (destructuring-bind (ahead negate inner-node) (rest node)
       (if ahead
           (let ((inner (compile-node inner-node (lambda (p) (declare (ignore p)) t))))
             (lambda (pos)
               (let ((saved (copy-seq *captures*)))
                 (if (funcall inner pos)
                     (if negate
                         (progn (replace *captures* saved) nil)
                         (or (funcall k pos) (progn (replace *captures* saved) nil)))
                     (and negate (funcall k pos))))))
           ;; Behind: some start before POS from which the node matches up to POS
           ;; exactly, no further back than the node is wide. Without captures
           ;; (refused above) which start is found does not matter, only whether one is.
           (multiple-value-bind (narrowest widest) (node-width inner-node)
             (let* ((target (list 0))
                    (inner (compile-node inner-node (lambda (p) (= p (car target))))))
               (lambda (pos)
                 (let ((found (let ((saved (car target)))
                                (setf (car target) pos)
                                (prog1 (loop for s from (- pos narrowest) downto (if widest (max 0 (- pos widest)) 0)
                                             thereis (progn (tick) (funcall inner s)))
                                  (setf (car target) saved)))))
                   (and (if negate (not found) found) (funcall k pos)))))))))
    (:repeat
     (destructuring-bind (min max greedy body) (rest node)
       (let ((test (unit-test-of body)))
         (if test
             ;; One unit at a time, no captures: the run is counted, then tried longest
             ;; (or shortest) first, as the recursion would.
             (lambda (pos)
               (let* ((limit (if max (min (+ pos max) (length *input*)) (length *input*)))
                      (run (loop for p from pos below limit while (funcall test (aref *input* p)) count t)))
                 (when (>= run min)
                   (if greedy
                       (loop for n from run downto min thereis (progn (tick) (funcall k (+ pos n))))
                       (loop for n from min to run thereis (progn (tick) (funcall k (+ pos n))))))))
             (let* ((slots (groups-in body))
                    (stack (list nil))
                    (inner (compile-node body (lambda (p) (funcall (car (car stack)) p)))))
               (labels ((repeat (pos min max)
                          (tick)
                          (if (eql max 0)
                              (funcall k pos)
                              (let ((d (lambda (p)
                                         (and (not (and (zerop min) (= p pos)))
                                              (repeat p (if (zerop min) 0 (1- min)) (and max (1- max)))))))
                                (flet ((body-at ()
                                         (let ((saved (loop for i in slots
                                                            collect (cons (aref *captures* (* 2 i)) (aref *captures* (1+ (* 2 i)))))))
                                           (dolist (i slots) (setf (aref *captures* (* 2 i)) nil (aref *captures* (1+ (* 2 i))) nil))
                                           (push d (car stack))
                                           (or (prog1 (funcall inner pos) (pop (car stack)))
                                               (progn (loop for i in slots for (s . e) in saved
                                                            do (setf (aref *captures* (* 2 i)) s (aref *captures* (1+ (* 2 i))) e))
                                                      nil)))))
                                  (cond ((/= min 0) (body-at))
                                        ((not greedy) (or (funcall k pos) (body-at)))
                                        (t (or (body-at) (funcall k pos)))))))))
                 (lambda (pos) (repeat pos min max))))))))))

(defstruct (regex (:constructor %make-regex)) matcher groups source backrefs)

(defun compile-regex (pattern &key (ignore-case t) multiline)
  "PATTERN compiled as `new RegExp(PATTERN, FLAGS)`, FLAGS i (the default, as
recall's search compiles a query) and m; signals REGEX-SYNTAX-ERROR where that
throws, REGEX-UNSUPPORTED where this port would not be sure to agree."
  (let ((*ignore-case* ignore-case) (*multiline* multiline))
    (multiple-value-bind (tree groups) (parse-regex (string-units pattern))
      (%make-regex :matcher (compile-node tree (lambda (p) p)) :groups groups :source pattern
                   :backrefs (tree-has tree :backref)))))

(defun regex-match-at (regex units start &optional captures)
  "The end of REGEX's match starting at START, or NIL; and its captures, a
vector of start and end units per group (group I at 2I and 2I+1). CAPTURES,
when given, is that vector to reuse, cleared here."
  (let ((*input* units)
        (*captures* (if captures
                        (fill captures nil)
                        (make-array (* 2 (1+ (regex-groups regex))) :initial-element nil))))
    (let ((end (funcall (regex-matcher regex) start)))
      (values end (and end *captures*)))))

(defun regex-search (regex units &optional (start 0))
  "The first match at or after START, as (values START END), or NIL: String.search, RegExp.exec."
  (let ((captures (make-array (* 2 (1+ (regex-groups regex))) :initial-element nil)))
    (loop for s from start to (length units)
          for end = (regex-match-at regex units s captures)
          when end return (values s end))))

(defun regex-test (regex units) (and (regex-search regex units) t))

(defun regex-count (regex units)
  "The matches String.match with a global regex finds: an empty match moves on one unit."
  (loop with i = 0 and count = 0
        while (<= i (length units))
        do (multiple-value-bind (s e) (regex-search regex units i)
             (unless s (return count))
             (incf count)
             (setf i (if (= e s) (1+ e) e)))
        finally (return count)))

;;; --- safeRegex ------------------------------------------------------------------

(defun escape-regex (string)
  "STRING with every regex metacharacter escaped: search-entries.ts escapeRegex."
  (with-output-to-string (out)
    (loop for c across string
          do (when (find c ".*+?^${}()|[]\\") (write-char #\\ out))
             (write-char c out))))

(defun quantifier-at (p i)
  "The quantifier of the pattern units P at I, as (values LENGTH UNBOUNDED)."
  (let ((u (and (< i (length p)) (aref p i))))
    (cond ((member u '(43 42)) (values 1 t))
          ((eql u 123)
           (let* ((end (position 125 p :start i))
                  (body (if end (subseq p (1+ i) end) (vector))))
             ;; /^\d+(,\d*)?$/
             (let* ((comma (position 44 body))
                    (head (subseq body 0 (or comma (length body))))
                    (tail (if comma (subseq body (1+ comma)) (vector))))
               (if (and (plusp (length head)) (every (lambda (d) (<= 48 d 57)) head)
                        (every (lambda (d) (<= 48 d 57)) tail))
                   (values (1+ (- end i)) (and comma (zerop (length tail))))
                   (values 0 nil)))))
          (t (values 0 nil)))))

(defun nested-quantifier-p (pattern)
  "An unbounded quantifier on a group that holds one, as `(a+)+`: search-entries.ts hasNestedQuantifier."
  (let ((p (string-units pattern)) (groups '()) (in-class nil) (i 0))
    (loop while (< i (length p))
          do (let ((u (aref p i)))
               (cond ((= u 92) (incf i))
                     (in-class (when (= u 93) (setf in-class nil)))
                     ((= u 91) (setf in-class t))
                     ((= u 40) (push nil groups))
                     ((= u 41)
                      (let ((inner (pop groups)))
                        (multiple-value-bind (len unbounded) (quantifier-at p (1+ i))
                          (when (and inner unbounded) (return-from nested-quantifier-p t))
                          (when groups (setf (first groups) (or (first groups) inner unbounded)))
                          (incf i len))))
                     (t (multiple-value-bind (len unbounded) (quantifier-at p i)
                          (when (and unbounded groups)
                            (setf (first groups) t)
                            (incf i (1- len)))))))
             (incf i))
    nil))

(defun safe-regex (pattern)
  "PATTERN as search-entries.ts safeRegex compiles it: its text literally when it
nests quantifiers or does not compile."
  (if (nested-quantifier-p pattern)
      (compile-regex (escape-regex pattern))
      (handler-case (compile-regex pattern)
        (regex-syntax-error () (compile-regex (escape-regex pattern))))))
