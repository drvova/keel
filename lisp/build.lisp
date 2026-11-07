;;;; build.lisp --- dump the core as one executable.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;;   sbcl --non-interactive --load lisp/build.lisp
;;;;
;;;; Writes lisp/build/keel-core, or KEEL_CORE_OUT when it is set.
;;;; :SAVE-RUNTIME-OPTIONS makes every argument the program's and keeps SBCL's
;;;; banner and REPL options out of it.

(require :asdf)
(let ((here (directory-namestring *load-truename*)))
  (push (pathname here) asdf:*central-registry*)
  (asdf:load-system "keel-core")
  (let ((target (or (uiop:getenv "KEEL_CORE_OUT")
                    (concatenate 'string here "build/keel-core"))))
    (ensure-directories-exist target)
    (sb-ext:save-lisp-and-die target
                              :executable t
                              :toplevel (fdefinition (find-symbol "MAIN" "KEEL"))
                              :save-runtime-options t)))
