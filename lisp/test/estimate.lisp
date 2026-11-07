;;;; estimate.lisp --- tests: how many chars, and so tokens, a message takes.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The cut, the tail budget and smart keep-tail all size messages this way
;;;; (compaction.lisp), and a compaction's chars per token is calibrated on the
;;;; context the host counted (window.lisp).

(in-package #:omp-vcc.test)

(defun chars-of (json) (message-chars (parse-json json)))
(defun content-of (json) (content-chars (parse-json json)))

(deftest tokens-round-up-so-nothing-is-undercounted
  (is (= (tokens-from-chars 0) 0))
  (is (= (tokens-from-chars 1) 1))
  (is (= (tokens-from-chars 4) 1))
  (is (= (tokens-from-chars 5) 2))
  (is (= (tokens-from-chars 5 2) 3) "at a calibrated ratio"))

(deftest chars-per-token-is-calibrated-and-clamped
  (let ((c (calibrate-chars-per-token 120 40)))
    (is (equal (json-get c "mode") "calibrated"))
    (is (eql (json-get c "charsPerToken") 3))
    (is (eql (json-get c "rawCharsPerToken") 3)))
  (is (eql (json-get (calibrate-chars-per-token 10 100) "charsPerToken") 2))
  (is (eql (json-get (calibrate-chars-per-token 1000 10) "charsPerToken") 6))
  (let ((c (calibrate-chars-per-token 1000 0)))
    (is (equal (json-get c "mode") "heuristic") "no usable token count")
    (is (eql (json-get c "charsPerToken") 4))))

(deftest the-floor-follows-the-script
  ;; Below 2 chars a token only CJK text goes: elsewhere it is a measurement gone wrong.
  (is (eql (clamp-chars-per-token 1.1d0) 2) "text in no CJK script")
  (is (= (clamp-chars-per-token 1.1d0 1) 1.1d0) "Chinese or Japanese text, 1-2 chars a token")
  (is (= (clamp-chars-per-token 0.5d0 1) 0.8d0) "and never below 0.8")
  (is (= (clamp-chars-per-token 1.1d0 1/2) 1.4d0) "half of it CJK")
  (is (= (cjk-share (list "abc" (map 'string #'code-char '(#x65E5 #x672C #x8A9E)))) 1/2) "日本語, written by code point")
  (is (= (cjk-share (list "")) 0)))

(deftest content-counts-every-part-that-carries-tokens
  (is (= (content-of "\"hello\"") 5))
  (is (= (content-of "[{\"type\":\"text\",\"text\":\"hello\"},{\"type\":\"toolCall\",\"name\":\"read\",\"input\":{\"path\":\"a.ts\"}},{\"type\":\"toolResult\",\"content\":\"done\"},{\"type\":\"image\",\"mimeType\":\"image/png\"}]")
         (+ 5 4 (length "{\"path\":\"a.ts\"}") 4 4800)))
  ;; omp's assistant content: thinking.thinking, and toolCall.arguments (not .input).
  (is (= (content-of "[{\"type\":\"thinking\",\"thinking\":\"reasoning\",\"thinkingSignature\":\"sig\"},{\"type\":\"text\",\"text\":\"answer\"},{\"type\":\"toolCall\",\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}]")
         (+ 9 6 4 (length "{\"command\":\"ls\"}"))))
  ;; Malformed and unknown parts count only the text they carry: a call with no
  ;; arguments counts its name and JSON.stringify("").
  (is (= (content-of "[{\"type\":\"thinking\"},{\"type\":\"toolCall\",\"name\":\"noop\"},{\"type\":\"mystery\",\"text\":\"x\"},null,\"not-an-object\"]")
         (+ 0 6 1 0 0))))

;; Seen in a sibling omp port's audit: omp's other message shapes carry their
;; text outside `content`, and measured 0, so a huge `!cmd` output was invisible
;; to the tail budget and smart keep.
(deftest every-shape-omp-writes-is-measured
  (is (= (chars-of (format nil "{\"role\":\"bashExecution\",\"command\":\"cat big.log\",\"output\":\"~a\",\"exitCode\":0}" (make-string 1000 :initial-element #\x))) 1011))
  (is (= (chars-of "{\"role\":\"pythonExecution\",\"code\":\"print(1)\",\"output\":\"1\"}") 9))
  (is (= (chars-of "{\"role\":\"branchSummary\",\"summary\":\"abc\"}") 3))
  (is (= (chars-of "{\"role\":\"compactionSummary\",\"summary\":\"abcd\"}") 4))
  (is (= (chars-of "{\"role\":\"fileMention\",\"files\":[{\"path\":\"a.md\",\"content\":\"hello\"}]}") 9))
  (is (= (chars-of "{\"role\":\"user\",\"content\":\"hi\"}") 2))
  (is (= (chars-of "null") 0)))
