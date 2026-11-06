;;;; package.lisp --- the core's one package.
;;;;
;;;; SPDX-License-Identifier: MIT

(defpackage #:omp-vcc
  (:documentation "omp-vcc's core: what a request asks, computed; the hosts' glue stays TypeScript.")
  (:use #:cl)
  (:export
   ;; --- js-string ---
   #:js-length #:js-slice #:js-whitespace-p #:js-trim #:js-split-whitespace
   #:js-char-equal #:join-strings #:split-string
   ;; --- json ---
   #:parse-json #:write-json #:json-string #:json-get #:json-object
   ;; --- search ---
   #:stem-of #:search-docs
   ;; --- server ---
   #:handle-request #:main))
