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
