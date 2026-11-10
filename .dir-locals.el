;;; Directory Local Variables for keel.  -*- lexical-binding: t; -*-
;;; For more information see (info "(emacs) Directory Variables")
;;;
;;; AUTOMATIC SLIME setup: just open any file in this project and run
;;;   M-x slime
;;; SBCL starts with keel-core already loaded and ready to hack on.
;;; Nothing else to type.  Full shell checks stay manual:
;;;   sbcl --non-interactive --load lisp/lint.lisp
;;;   sbcl --non-interactive --eval '(require :asdf)' \
;;;     --eval '(push (truename "lisp/") asdf:*central-registry*)' \
;;;     --eval '(asdf:test-system "keel-core")'
;;;   bun run typecheck && bun test
;;;
;;; First time Emacs asks about these unsafe dir-local variables, answer `!'
;;; to remember them; after that it is fully automatic.
;;;
;;; What the eval below does: finds the project root (this file's dir),
;;; builds absolute paths, and defines a project-local `keel-sbcl'
;;; SLIME implementation whose SBCL starts with: ASDF required, default
;;; dir set to the project root, lisp/ on the ASDF registry, the .asd
;;; loaded, and keel-core loaded.  `slime-default-lisp' points at it.
;;;;;; If you use SLY instead of SLIME this does not apply; run
;;;   (asdf:load-asd "lisp/keel-core.asd")
;;;   (asdf:load-system "keel-core")
;;; by hand there (load-asd, not load: the .asd uses a bare DEFSYSTEM).
;;; Load order is in lisp/keel-core.asd; session text is
;;; never given to the Lisp reader.  See AGENTS.md "The Lisp core".

((nil . ((eval . (progn
                   (let* ((root (or (locate-dominating-file default-directory ".dir-locals.el")
                                    default-directory))
                          (root-dir (file-name-as-directory (expand-file-name root)))
                          (lisp-dir (file-name-as-directory (expand-file-name "lisp/" root)))
                          (asd-file (expand-file-name "lisp/keel-core.asd" root)))
                     (setq-local slime-lisp-implementations
                                 `((keel-sbcl
                                    ("sbcl" "--dynamic-space-size" "4096"
                                     "--eval" "(require :asdf)"
                                     "--eval" ,(format "(setf *default-pathname-defaults* #P\"%s\")" root-dir)
                                     "--eval" ,(format "(pushnew #P\"%s\" asdf:*central-registry* :test #'equal)" lisp-dir)
                                     "--eval" ,(format "(asdf:load-asd %s)" (prin1-to-string asd-file))
                                     "--eval" "(asdf:load-system \"keel-core\")"
                                     "--eval" "(format t \"~&[keel] keel-core ready (~a)~%\" *default-pathname-defaults*)"))
                                   (sbcl ("sbcl"))))
                     (setq-local slime-default-lisp 'keel-sbcl)
                     (setq-local inferior-lisp-program "sbcl")))))))
