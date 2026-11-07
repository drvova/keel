;;;; store.lisp --- tests: what omp rewrote, and its original put back (session.lisp).
;;;;
;;;; SPDX-License-Identifier: MIT

(in-package #:omp-vcc.test)

(defun msg (json) (parse-json json))

(deftest what-omp-rewrote-is-told-by-its-placeholders
  (is (was-rewritten-p (msg "{\"role\":\"toolResult\",\"content\":[{\"type\":\"text\",\"text\":\"[Output truncated - 900 tokens]\"}],\"prunedAt\":5}")))
  (is (was-rewritten-p (msg "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"see [… moved to artifact://3]\"}]}")))
  (is (not (was-rewritten-p (msg "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"plain\"}]}")))))

(deftest a-tool-result-takes-its-original-whole-another-message-block-by-block
  (is (string= (json-string (with-original-content
                             (msg "{\"role\":\"toolResult\",\"content\":[{\"type\":\"text\",\"text\":\"[Output truncated]\"}],\"prunedAt\":5,\"toolCallId\":\"c\"}")
                             (msg "[{\"type\":\"text\",\"text\":\"full output\"}]")))
               "{\"role\":\"toolResult\",\"content\":[{\"type\":\"text\",\"text\":\"full output\"}],\"toolCallId\":\"c\"}"))
  (let ((call "{\"type\":\"toolCall\",\"id\":\"t\",\"name\":\"read\",\"arguments\":{\"path\":\"a.ts\"}}"))
    (is (string= (json-string (with-original-content
                               (msg (format nil "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"[artifact://3]\"},~a]}" call))
                               (msg (format nil "[{\"type\":\"text\",\"text\":\"the block\"},~a]" call))))
                 (format nil "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"the block\"},~a]}" call)))))
