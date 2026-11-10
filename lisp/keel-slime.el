;;; keel-slime.el --- Fire core requests at keel's Lisp core through SLIME.  -*- lexical-binding: t; -*-
;;;
;;; SPDX-License-Identifier: MIT
;;;
;;; The core's contract is one JSON object in, one out (lisp/src/server.lisp).
;;; With the project's .dir-locals.el, M-x slime already boots SBCL with
;;; keel-core loaded, so this file turns Emacs into a third host: point at a
;;; request, C-c k j, read the answer.  No bun, no build, no process spawn:
;;; the request is evaluated in the live image, where the inspector,
;;; the debugger and C-c C-c on a defun all work on the same state.
;;;
;;; The request is the region when one is active, else the whole buffer, as
;;; text.  The answer goes to *keel-response*, exactly as the core wrote it
;;; (pretty-printed by the core itself, as JSON.stringify(..., null, 2)).
;;; Anything the core refuses is answered {ok:false,...}, never thrown:
;;; a bad request shows up as text, not a debugger.
;;;
;;; C-c k j  keel-send-request   (in any slime-mode buffer)
;;; C-c k t  keel-run-lisp-tests

(require 'slime nil t)

(defgroup keel-slime nil
  "Fire requests at keel's Lisp core through SLIME."
  :group 'languages
  :prefix "keel-slime-")

(defcustom keel-slime-response-buffer-name "*keel-response*"
  "Buffer `keel-send-request' writes the core's answer into."
  :type 'string
  :group 'keel-slime)

(defcustom keel-slime-connect-timeout 120
  "Seconds to wait for SLIME to connect before giving up."
  :type 'number
  :group 'keel-slime)

(defvar keel-slime-after-response-hook nil
  "Hook run after a response lands.  Functions take the response string.")

(defun keel-slime-project-root ()
  "The keel project root: the directory holding .dir-locals.el."
  (let ((root (locate-dominating-file (or (buffer-file-name) default-directory)
                                      ".dir-locals.el")))
    (and root (file-name-as-directory (expand-file-name root)))))

(defun keel-slime-implementations (root)
  "The `slime-lisp-implementations' value for project ROOT.
keel-sbcl starts SBCL with keel-core already loaded: ASDF required,
default dir on the project root, lisp/ on the ASDF registry, the .asd
loaded with load-asd (bare DEFSYSTEM: load would fail), and the system
loaded."
  (let* ((root-dir (file-name-as-directory (expand-file-name root)))
         (lisp-dir (file-name-as-directory (expand-file-name "lisp/" root)))
         (asd-file (expand-file-name "lisp/keel-core.asd" root)))
    `((keel-sbcl
       ("sbcl" "--dynamic-space-size" "4096"
        "--eval" "(require :asdf)"
        "--eval" ,(format "(setf *default-pathname-defaults* #P\"%s\")" root-dir)
        "--eval" ,(format "(pushnew #P\"%s\" asdf:*central-registry* :test #'equal)" lisp-dir)
        "--eval" ,(format "(asdf:load-asd %s)" (prin1-to-string asd-file))
        "--eval" "(asdf:load-system \"keel-core\")"
        "--eval" "(format t \"~&[keel] keel-core ready (~a)~%\" *default-pathname-defaults*)"))
      (sbcl ("sbcl")))))

(defun keel-slime-setup-local ()
  "Point this buffer's SLIME at the project core.  Called from .dir-locals.el."
  (let ((root (keel-slime-project-root)))
    (when root
      (setq-local slime-lisp-implementations (keel-slime-implementations root))
      (setq-local slime-default-lisp 'keel-sbcl)
      (setq-local inferior-lisp-program "sbcl"))))

(defun keel-slime-ensure-connection (root)
  "Connect SLIME to the project core, starting it when needed.
Returns the connection, or nil when it did not come up in time."
  (or (and (slime-connected-p) (slime-connection))
      (let ((slime-lisp-implementations (keel-slime-implementations root))
            (slime-default-lisp 'keel-sbcl))
        (slime)
        (let ((waited 0))
          (while (and (not (slime-connected-p))
                      (< waited keel-slime-connect-timeout))
            (accept-process-output nil 1)
            (setq waited (1+ waited)))
          (and (slime-connected-p) (slime-connection))))))

(defun keel-slime--show-response (response)
  "Write RESPONSE to the response buffer and run the hook."
  (let ((buf (get-buffer-create keel-slime-response-buffer-name)))
    (with-current-buffer buf
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (if (stringp response) response (format "%S" response)))))
    (run-hook-with-args 'keel-slime-after-response-hook response)
    (pop-to-buffer buf)))

(defun keel-send-request (beg end)
  "Send BEG..END (region, else whole buffer) to the core as one request.
The answer lands in `keel-slime-response-buffer-name'.  Starts SLIME on
the project implementation when it is not connected yet."
  (interactive (if (use-region-p)
                   (list (region-beginning) (region-end))
                 (list (point-min) (point-max))))
  (let ((root (keel-slime-project-root)))
    (unless root
      (error "keel-send-request must run inside the keel project"))
    (let ((request (buffer-substring-no-properties beg end)))
      (unless (keel-slime-ensure-connection root)
        (error "SLIME did not connect within %s s" keel-slime-connect-timeout))
      (message "keel: firing %s of request ..." (length request))
      (slime-eval-async `(keel::json-pretty-string (keel::respond ,request))
                        #'keel-slime--show-response))))

(defun keel-run-lisp-tests ()
  "Run (asdf:test-system \"keel-core\") in the connected image."
  (interactive)
  (let ((root (keel-slime-project-root)))
    (unless root
      (error "keel-run-lisp-tests must run inside the keel project"))
    (unless (keel-slime-ensure-connection root)
      (error "SLIME did not connect within %s s" keel-slime-connect-timeout))
    (message "keel: running (asdf:test-system \"keel-core\") ...")
    (slime-eval-async '(asdf:test-system "keel-core")
                      (lambda (ok)
                        (message "keel: Lisp tests %s"
                                 (if ok "passed" "FAILED (see *inferior-lisp*)"))))))

(with-eval-after-load 'slime
  (when (boundp 'slime-mode-map)
    (unless (lookup-key slime-mode-map (kbd "C-c k"))
      (define-key slime-mode-map (kbd "C-c k") (make-sparse-keymap)))
    (let ((prefix (lookup-key slime-mode-map (kbd "C-c k"))))
      (when (keymapp prefix)
        (define-key prefix (kbd "j") #'keel-send-request)
        (define-key prefix (kbd "t") #'keel-run-lisp-tests)))))


(provide 'keel-slime)
;;; keel-slime.el ends here
