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
;;; lisp/keel-slime.el (loaded below) turns Emacs into a third host for the
;;; core, no bun, no build, no process spawn:
;;;   C-c k j  keel-send-request   (region, else buffer, as one core request)
;;;   C-c k t  keel-run-lisp-tests (asdf:test-system "keel-core" in the image)
;;; lisp/keel-replay.el steps a KEEL_REPLAY_OUT log through the live image:
;;;   C-c k r  keel-replay-start   C-c k n/p  next/prev   C-c k a  run to end
;;;
;;; First time Emacs asks about these unsafe dir-local variables, answer `!'
;;; to remember them; after that it is fully automatic.
;;;
;;; The eval loads lisp/keel-slime.el (single source of truth for the boot
;;; command) and points this buffer's SLIME at the project core.
;;;;;; If you use SLY instead of SLIME this does not apply; run
;;;   (asdf:load-asd "lisp/keel-core.asd")
;;;   (asdf:load-system "keel-core")
;;; by hand there (load-asd, not load: the .asd uses a bare DEFSYSTEM).
;;; Load order is in lisp/keel-core.asd; session text is
;;; never given to the Lisp reader.  See AGENTS.md "The Lisp core".

((nil . ((eval . (let ((root (locate-dominating-file default-directory ".dir-locals.el")))
                   (when root
                     (load (expand-file-name "lisp/keel-slime.el" root) nil t t)
                     (load (expand-file-name "lisp/keel-replay.el" root) nil t t)
                     (when (featurep 'keel-slime)
                       (keel-slime-setup-local))))))))
