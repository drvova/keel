;;;; settings.lisp --- omp-vcc's config file: read as settings, and scaffolded.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The settings are each value of the file in its default's type; the
;;;; scaffold writes the file whole. The TS side (src/core/settings.ts)
;;;; resolves where the file is (the host's agent directory, or
;;;; OMP_VCC_CONFIG_PATH) and whether the pre-rename pi-vcc-config.json may be
;;;; copied; the core reads and writes the file itself. What it writes is what
;;;; JSON.stringify(value, null, 2) writes, with a newline after.

(in-package #:omp-vcc)

;; The settings' keys in the order the scaffold writes them, with their defaults.
(defparameter +default-settings+
  '(("overrideDefaultCompaction" . :true) ("smartKeepTail" . :true) ("debug" . :false)
    ("skipForProviders" . :list) ("skipCustomTypes" . :list) ("trackCommands" . :list)
    ("keepOriginals" . :true) ("workingSet" . :true)))

(defun default-setting (value) (if (eq value :list) (vector) value))

(defun default-settings ()
  (let ((settings (make-hash-table :test 'equal)))
    (loop for (key . value) in +default-settings+ do (setf (gethash key settings) (default-setting value)))
    settings))

(defun native-path (path) (sb-ext:parse-native-namestring path))

(defun read-json-file (path)
  "JSON.parse(readFileSync(PATH, \"utf-8\")), or NIL when it does not read or parse."
  (ignore-errors
   (with-open-file (in (native-path path) :element-type '(unsigned-byte 8))
     (let ((bytes (make-array (file-length in) :element-type '(unsigned-byte 8))))
       (read-sequence bytes in)
       (parse-json (decode-utf-8 bytes))))))

(defun write-text-file (path text)
  "PATH holds TEXT in UTF-8 now, truncated in place as writeFileSync does."
  (with-open-file (out (native-path path) :direction :output :if-exists :supersede :if-does-not-exist :create
                                          :external-format :utf-8)
    (write-string text out)))

(defun switch-of (v)
  "A switch as written: a boolean, or \"true\"/\"false\" in quotes; anything else is NIL."
  (cond ((member v '(:true :false)) v)
        ((stringp v)
         (let ((s (js-trim v)))
           (when (every (lambda (c) (< (char-code c) 128)) s)
             (cond ((string-equal s "true") :true) ((string-equal s "false") :false)))))))

(defun parse-settings (parsed)
  "The settings PARSED (the file's JSON) gives: each value only in its default's type."
  (let ((settings (default-settings)))
    (when (hash-table-p parsed)
      (loop for (key . value) in +default-settings+
            when (member value '(:true :false))
              do (let ((on (switch-of (json-get parsed key)))) (when on (setf (gethash key settings) on))))
      (setf (gethash "skipForProviders" settings) (coerce (strings-of (json-get parsed "skipForProviders")) 'vector)
            (gethash "skipCustomTypes" settings) (coerce (strings-of (json-get parsed "skipCustomTypes")) 'vector)
            ;; Blank names would match every command; duplicates would repeat lines.
            (gethash "trackCommands" settings)
            (coerce (remove-duplicates (remove "" (mapcar #'js-trim (strings-of (json-get parsed "trackCommands"))) :test #'string=)
                                       :test #'string= :from-end t)
                    'vector)))
    settings))

(defun load-settings (path) (parse-settings (read-json-file path)))

(defun spread-object (value)
  "`{...VALUE}` for an object or an array (its indices as keys)."
  (if (hash-table-p value)
      (copy-json-object value)
      (let ((object (make-hash-table :test 'equal)))
        (loop for v across value for i from 0 do (setf (gethash (format nil "~d" i) object) v))
        object)))

(defun scaffold-settings (path legacy)
  "Config.scaffold: the file at PATH with every default key. Missing: LEGACY's
copy when there is one, else the defaults. Not JSON: left alone. Valid: missing
keys added, existing values kept. Nothing here fails the caller."
  (ignore-errors
   (ensure-directories-exist (native-path path))
   (unless (probe-file (native-path path))
     (if (and legacy (probe-file (native-path legacy)))
         (with-open-file (in (native-path legacy) :element-type '(unsigned-byte 8))
           (with-open-file (out (native-path path) :direction :output :element-type '(unsigned-byte 8)
                                                   :if-exists :supersede :if-does-not-exist :create)
             (let ((bytes (make-array (file-length in) :element-type '(unsigned-byte 8))))
               (read-sequence bytes in)
               (write-sequence bytes out))))
         (progn (write-text-file path (format nil "~a~%" (json-pretty-string (default-settings))))
                (return-from scaffold-settings))))
   (let ((parsed (read-json-file path)))
     (when (or (hash-table-p parsed) (json-array-p parsed))
       (let ((next (spread-object parsed)) (changed nil))
         (loop for (key . value) in +default-settings+
               unless (nth-value 1 (gethash key next))
                 do (setf (gethash key next) (default-setting value) changed t))
         (when changed (write-text-file path (format nil "~a~%" (json-pretty-string next)))))))))
