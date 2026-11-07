;;;; numbers.lisp --- tests: what #N counts (session.lisp), the refs every summary and recall share.
;;;;
;;;; SPDX-License-Identifier: MIT

(in-package #:omp-vcc.test)

(defun entries (&rest jsons) (map 'vector #'parse-json jsons))

(deftest n-counts-message-entries-in-file-order-only
  (let ((by-id (index-by-id (entries "{\"type\":\"session\",\"id\":\"header\"}"
                                     "{\"id\":\"m1\",\"type\":\"message\",\"message\":{\"role\":\"user\"}}"
                                     "{\"id\":\"c1\",\"type\":\"compaction\",\"firstKeptEntryId\":\"\"}"
                                     "{\"id\":\"x1\",\"type\":\"custom_message\",\"customType\":\"ext.foo\"}"
                                     "{\"id\":\"m2\",\"type\":\"message\",\"message\":{\"role\":\"assistant\"}}"
                                     "{\"id\":\"m3\",\"type\":\"message\",\"message\":{\"role\":\"toolResult\"}}"))))
    (is (eql (gethash "m1" by-id) 0))
    (is (eql (gethash "m2" by-id) 1))
    (is (eql (gethash "m3" by-id) 2))
    (is (not (nth-value 1 (gethash "c1" by-id))))
    (is (not (nth-value 1 (gethash "x1" by-id))))))

(deftest an-id-seen-twice-has-no-n-but-still-takes-its-place
  ;; A ref is missing rather than wrong.
  (let ((by-id (index-by-id (entries "{\"id\":\"a\",\"type\":\"message\",\"message\":{\"role\":\"user\"}}"
                                     "{\"id\":\"a\",\"type\":\"message\",\"message\":{\"role\":\"assistant\"}}"
                                     "{\"id\":\"b\",\"type\":\"message\",\"message\":{\"role\":\"assistant\"}}"))))
    (is (not (nth-value 1 (gethash "a" by-id))))
    (is (eql (gethash "b" by-id) 2))))

(deftest a-message-without-an-id-still-takes-its-place
  (is (eql (gethash "x" (index-by-id (entries "{\"type\":\"message\",\"message\":{\"role\":\"user\"}}"
                                              "{\"id\":\"x\",\"type\":\"message\",\"message\":{\"role\":\"assistant\"}}")))
           1)))

(deftest only-an-entry-that-holds-a-message-is-counted
  (is (counted-entry-p (parse-json "{\"type\":\"message\",\"message\":{}}")))
  (is (not (counted-entry-p (parse-json "{\"type\":\"message\"}"))))
  (is (not (counted-entry-p (parse-json "{\"type\":\"message\",\"message\":null}"))))
  (is (not (counted-entry-p (parse-json "{\"type\":\"compaction\"}")))))

;;; rx.lisp js-number-of: Number() of a JSON value, read without the Lisp reader.

(deftest number-reads-strings-as-javascript-does
  (loop for (text want) in '(("12" 12) ("  12  " 12) ("" 0) ("+5" 5) ("-5" -5) ("5." 5) (".5" 0.5d0) ("1e3" 1000)
                             ("1.5e3" 1500) ("2.5" 2.5d0) ("0x10" 16) ("0b101" 5) ("0o17" 15) ("0e999" 0) ("1e-999" 0)
                             ("1.0" 1))
        do (is (eql (js-number-of text) want) (format nil "Number(~s) is ~a, not ~a" text want (js-number-of text))))
  (dolist (text '("." "+" "1e" "1x" "-0x10" "Infinity" "1e999" "1_0" "pkg::sym" "#.(boom)" "1/2"))
    (is (null (js-number-of text)) (format nil "Number(~s) is NaN, not ~a" text (js-number-of text)))))
