;;;; package.lisp --- the core's one package.
;;;;
;;;; SPDX-License-Identifier: MIT

(defpackage #:keel
  (:documentation "keel's core: what a request asks, computed; the hosts' glue stays TypeScript.")
  (:use #:cl)
  (:export
   ;; --- js-string ---
   #:js-length #:js-slice #:js-whitespace-p #:js-trim #:js-split-whitespace
   #:join-strings #:split-string
   ;; --- json ---
   #:parse-json #:write-json #:json-string #:json-get #:json-object #:json-keys #:json-values
   ;; --- search ---
   #:stem-of #:search-docs
   ;; --- server ---
   #:handle-request #:main))
