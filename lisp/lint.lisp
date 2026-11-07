;;;; lint.lisp --- check the core with SBCL's own compiler, and for dead functions.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;;   sbcl --non-interactive --load lisp/lint.lisp
;;;;
;;;; Compiles every source file afresh and reports each warning and style
;;;; warning the compiler raises (an undefined function or variable, an unused
;;;; variable, a redefinition, a call with the wrong arguments, a type that
;;;; cannot hold), with the file it came from; then each function defined in
;;;; lisp/src that nothing in lisp/src, lisp/test or build.lisp names. Exits 1 on any.
;;;; It needs nothing but SBCL, so it runs where the core is built.

(require :asdf)

(defvar *here* (directory-namestring *load-truename*))
(push (truename *here*) asdf:*central-registry*)

(defvar *findings* '())
(defvar *file* nil "The source file being compiled.")

(defun file-defines-macro-p (name)
  "Whether the file being compiled defines the macro NAME itself."
  (let ((text (with-open-file (in *file* :external-format :utf-8)
                (let ((s (make-string (file-length in)))) (subseq s 0 (read-sequence s in))))))
    (search (format nil "(defmacro ~(~a~) " name) text)))

(defun note-finding (kind condition)
  (push (format nil "~a: ~a: ~a" (if *file* (file-namestring *file*) "?") kind
                (substitute #\Space #\Newline (princ-to-string condition)))
        *findings*))

;;; --- the compiler's warnings ---------------------------------------------------------

(let ((system (asdf:find-system "omp-vcc-core"))
      (out (merge-pathnames (format nil "omp-vcc-lint-~d/" (random 1000000 (make-random-state t))) (uiop:temporary-directory))))
  (ensure-directories-exist out)
  (handler-bind ((sb-kernel:redefinition-with-defmacro
                   ;; compile-file defines a macro for the rest of its file, and loading
                   ;; the fasl defines it again: no second definition, so not a finding.
                   (lambda (c)
                     (when (file-defines-macro-p (string (sb-kernel::redefinition-warning-name c)))
                       (muffle-warning c))))
                 (style-warning (lambda (c) (note-finding "style" c) (muffle-warning c)))
                 (warning (lambda (c) (note-finding "warning" c) (muffle-warning c))))
    ;; Each file compiled afresh, where *FILE* names it, and loaded for the next;
    ;; one compilation unit, so an undefined function is told once, at its end,
    ;; only if nothing defines it.
    (with-compilation-unit ()
      (dolist (c (asdf:component-children (asdf:find-component system "src")))
        (let* ((*file* (asdf:component-pathname c))
               (fasl (compile-file *file* :output-file (merge-pathnames (make-pathname :name (pathname-name *file*) :type "fasl") out))))
          (load fasl)))))
  (uiop:delete-directory-tree out :validate t))

;;; --- functions nothing names -----------------------------------------------------------

(defun lisp-files (dir)
  (directory (merge-pathnames "*.lisp" (merge-pathnames dir *here*))))

(defun file-text (path)
  (with-open-file (in path :external-format :utf-8)
    (let ((s (make-string (file-length in))))
      (subseq s 0 (read-sequence s in)))))

(defun defined-functions (text)
  "The names after each (defun, (defmacro and (defgeneric at the start of a line."
  (let ((names '()))
    (loop for start = 0 then (1+ at)
          for at = (search (format nil "~%(def") text :start2 start)
          while at
          do (let* ((head-end (position #\Space text :start (1+ at)))
                    (head (subseq text (+ at 2) head-end)))
               (when (member head '("defun" "defmacro" "defgeneric") :test #'string=)
                 (let* ((name-start (1+ head-end))
                        (name-end (position-if (lambda (ch) (member ch '(#\Space #\Newline #\( #\)))) text :start name-start)))
                   (push (subseq text name-start name-end) names)))))
    names))

(defun name-char-p (ch) (or (alphanumericp ch) (find ch "-+*/<>=!?%&$:")))

(defun mentions (text name)
  "How often NAME appears in TEXT as a whole symbol."
  (loop for start = 0 then (+ at (length name))
        for at = (search name text :start2 start :test #'char-equal)
        while at
        count (and (or (zerop at) (not (name-char-p (char text (1- at)))))
                   (let ((end (+ at (length name)))) (or (= end (length text)) (not (name-char-p (char text end))))))))

(let* ((sources (lisp-files "src/"))
       ;; build.lisp names the executable's entry point.
       (all (append sources (lisp-files "test/") (list (merge-pathnames "build.lisp" *here*))))
       (texts (mapcar #'file-text all))
       (corpus (format nil "~{~a~%~}" texts)))
  (dolist (file sources)
    (dolist (name (defined-functions (file-text file)))
      ;; Its definition is one mention; a struct's accessors and the ops are named elsewhere.
      (when (<= (mentions corpus name) 1)
        (push (format nil "~a: unused: ~a is defined and named nowhere else" (file-namestring file) name) *findings*)))))

(let ((findings (reverse *findings*)))
  (format t "~&~{~a~%~}~d finding~:p~%" findings (length findings))
  (sb-ext:exit :code (if findings 1 0)))
