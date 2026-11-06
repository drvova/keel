;;;; server.lisp --- one request in, one response out.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The executable reads one JSON object from stdin and writes one to stdout,
;;;; then exits: src/core/lisp-core.ts runs it with spawnSync, so the recall
;;;; code that calls it stays synchronous, and nothing outlives a request. A
;;;; start costs ~5 ms (the dumped image is mapped, not loaded).
;;;;
;;;; Request:  {"op":"search","query":Q,"docs":[{"role":R,"text":T,"files":[F...]}...],
;;;;            "floor":X?,"cap":N?}
;;;; Response: {"ok":true,"hits":[{"index":I,"snippet":S|null}...],"totalBeforeCap":N,"truncated":B}
;;;;           {"ok":false,"unsupported":"regex"}      the caller searches as before
;;;;           {"ok":false,"error":MESSAGE}            and so on any failure
;;;;
;;;; Any error is answered, never thrown past MAIN: a caller that gets no
;;;; answer falls back, so a broken core costs speed, not recall.

(in-package #:omp-vcc)

(defun bool (x) (if x :true :false))

(defun request-docs (request)
  (map 'vector
       (lambda (doc)
         (list (let ((role (json-get doc "role"))) (if (stringp role) role ""))
               (let ((text (json-get doc "text"))) (if (stringp text) text ""))
               (let ((files (json-get doc "files" #())))
                 (if (vectorp files) (remove-if-not #'stringp (coerce files 'list)) '()))))
       (let ((docs (json-get request "docs" #()))) (if (vectorp docs) docs #()))))

(defun handle-search (request)
  (let ((floor (json-get request "floor"))
        (cap (json-get request "cap")))
    (multiple-value-bind (hits total truncated)
        (search-docs (let ((q (json-get request "query"))) (if (stringp q) q ""))
                     (request-docs request)
                     :floor (if (realp floor) (coerce floor 'double-float) +relative-floor+)
                     :cap (if (integerp cap) cap +result-cap+))
      (if (eq hits :regex)
          (json-object "ok" :false "unsupported" "regex")
          (json-object "ok" :true
                       "hits" (map 'vector (lambda (h) (json-object "index" (car h) "snippet" (or (cdr h) :null))) hits)
                       "totalBeforeCap" total
                       "truncated" (bool truncated))))))

(defun handle-request (request)
  "The response object to the parsed REQUEST."
  (let ((op (json-get request "op")))
    (cond ((equal op "search") (handle-search request))
          (t (json-object "ok" :false "error" (format nil "unknown op ~a" (json-string (or op :null))))))))

(defun read-stdin ()
  "Everything on stdin, decoded from UTF-8. Read as bytes and decoded at once:
a character stream decodes one character at a time, ten times slower on a
large request."
  (let ((in (sb-sys:make-fd-stream 0 :input t :element-type '(unsigned-byte 8) :buffering :full))
        (chunks '()) (total 0))
    (loop for chunk = (make-array 1048576 :element-type '(unsigned-byte 8))
          for n = (read-sequence chunk in)
          while (plusp n)
          do (push (cons chunk n) chunks) (incf total n))
    (let ((bytes (make-array total :element-type '(unsigned-byte 8))) (at 0))
      (dolist (c (nreverse chunks))
        (replace bytes (car c) :start1 at :end2 (cdr c))
        (incf at (cdr c)))
      (sb-ext:octets-to-string bytes :external-format :utf-8))))

(defun main ()
  "Entry point of the dumped executable."
  (let ((response (handler-case
                      (handle-request (parse-json (read-stdin)))
                    (error (e) (json-object "ok" :false "error" (princ-to-string e))))))
    (write-json response *standard-output*)
    (terpri *standard-output*)
    (finish-output *standard-output*)
    (sb-ext:exit :code 0 :abort t)))
