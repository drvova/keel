;;;; build.lisp --- dump the core as one executable.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;;   sbcl --non-interactive --load lisp/build.lisp
;;;;
;;;; Writes lisp/build/omp-vcc-core, or OMP_VCC_CORE_OUT when it is set.
;;;; :SAVE-RUNTIME-OPTIONS makes every argument the program's and keeps SBCL's
;;;; banner and REPL options out of it.

(require :asdf)
(let ((here (directory-namestring *load-truename*)))
  (push (pathname here) asdf:*central-registry*)
  (asdf:load-system "omp-vcc-core")
  (let ((target (or (uiop:getenv "OMP_VCC_CORE_OUT")
                    (concatenate 'string here "build/omp-vcc-core"))))
    (ensure-directories-exist target)
    (sb-ext:save-lisp-and-die target
                              :executable t
                              :toplevel (fdefinition (find-symbol "MAIN" "OMP-VCC"))
                              :save-runtime-options t)))
