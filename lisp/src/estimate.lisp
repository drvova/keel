;;;; estimate.lisp --- how many tokens a message holds, by its chars.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Every size keel works out (the compaction's budgets, what eviction frees, the
;;;; dashboard) is chars over a chars-per-token ratio: the model's own as a request
;;;; measured it (limits.lisp keeps it), else 4. A message's chars are those of every
;;;; part that carries tokens, an image counted as a fixed share.

(in-package #:keel)

(defun dbl (x) (coerce x 'double-float))

(defparameter +image-content-chars+ 4800)

(defparameter +default-chars-per-token+ 4)

(defun js-json-length (value)
  "The length of JSON.stringify(VALUE ?? \"\")."
  (js-length (json-string (if (or (null value) (eq value :null)) "" value))))

(defun content-chars (content)
  "The chars of every token-bearing part of a message's content."
  (cond ((stringp content) (js-length content))
        ((not (json-array-p content)) 0)
        (t (loop for part across content
                 sum (if (not (json-object-p part))
                         0
                         (let ((type (json-get part "type")) (text (json-get part "text")))
                           (cond ((equal type "text") (if (stringp text) (js-length text) 0))
                                 ((equal type "thinking") (let ((th (json-get part "thinking"))) (if (stringp th) (js-length th) 0)))
                                 ((equal type "toolCall")
                                  (let* ((a (json-get part "arguments"))
                                         (args (if (or (null a) (eq a :null)) (json-get part "input") a))
                                         (name (json-get part "name")))
                                    (+ (if (stringp name) (js-length name) 0)
                                       (if (stringp args) (js-length args) (js-json-length args)))))
                                 ((equal type "toolResult")
                                  (let ((c (json-get part "content"))) (if (stringp c) (js-length c) (js-json-length c))))
                                 ((equal type "image") +image-content-chars+)
                                 (t (if (stringp text) (js-length text) 0)))))))))

(defun message-chars (m)
  "The chars of one message, whatever its shape."
  (if (not (json-object-p m))
      0
      (flet ((len (v) (if (stringp v) (js-length v) 0)))
        (let ((role (json-get m "role")))
          (cond ((execution-of m) (multiple-value-bind (command output) (execution-of m) (+ (js-length command) (js-length output))))
                ((member role '("branchSummary" "compactionSummary") :test #'equal) (len (json-get m "summary")))
                ((equal role "fileMention")
                 (let ((files (json-get m "files")))
                   (if (json-array-p files)
                       (loop for f across files
                             sum (+ (len (json-get f "path")) (len (json-get f "content"))
                                    (if (truthy-p (json-get f "image")) +image-content-chars+ 0)))
                       0)))
                (t (content-chars (json-get m "content"))))))))

(defun tokens-from-chars (chars &optional (per-token +default-chars-per-token+))
  "Math.ceil(chars / charsPerToken)."
  (ceiling (/ (coerce chars 'double-float) per-token)))

(defun message-tokens (m per-token) (tokens-from-chars (message-chars m) (or per-token +default-chars-per-token+)))

(defparameter +chars-per-token-range+ '(0.8d0 . 6)
  "What a calibration can come to. Code and agent text run 3.5-4 chars per token,
English prose about 5.4, shell listings about 2, and Chinese and Japanese 1-2
(measured on cl100k, o200k, Llama 3, Qwen 3 and DeepSeek V3 tokenizers).")

(defun cjk-char-p (c)
  (let ((code (char-code c)))
    (or (<= #x3040 code #x30FF) (<= #x3400 code #x4DBF) (<= #x4E00 code #x9FFF) (<= #xAC00 code #xD7AF) (<= #xF900 code #xFAFF))))

(defun cjk-share (texts)
  "The share of TEXTS' characters in Chinese, Japanese or Korean script."
  (let ((all 0) (cjk 0))
    (dolist (text texts)
      (when (stringp text)
        (incf all (length text))
        (incf cjk (count-if #'cjk-char-p text))))
    (if (zerop all) 0 (/ cjk all))))

(defun clamp-chars-per-token (raw &optional (cjk 0))
  "RAW within +CHARS-PER-TOKEN-RANGE+, its floor 2 for text in no CJK script and
lower as the share CJK of it grows: below 2 chars a token only CJK text goes,
and elsewhere it is a measurement gone wrong (a prompt counted with what the
messages do not hold)."
  (let* ((floor (max (car +chars-per-token-range+) (- 2 (* 1.2d0 cjk))))
         (c (min (cdr +chars-per-token-range+) (max floor raw))))
    (if (= c (ftruncate c)) (truncate c) c)))

(defun calibrate-chars-per-token (chars tokens &optional (cjk 0))
  "Chars per token from CHARS of messages the host counted as TOKENS, clamped
(CLAMP-CHARS-PER-TOKEN, CJK the share of them in CJK script); the 4-char
heuristic when the host counted none."
  (if (or (not (realp tokens)) (<= tokens 0) (<= chars 0))
      (json-object "mode" "heuristic" "charsPerToken" +default-chars-per-token+)
      (let ((raw (/ (dbl chars) (dbl tokens))))
        (json-object "mode" "calibrated"
                     "charsPerToken" (clamp-chars-per-token raw cjk)
                     "sourceChars" chars "sourceTokens" tokens
                     "rawCharsPerToken" (if (= raw (ftruncate raw)) (truncate raw) raw)))))

(defun number-or-zero (v) (or (js-number-of v) 0))

(defun usage-prompt-tokens (m)
  "The prompt the provider counted for the request that made assistant message M
(input, cache reads and cache writes), or NIL."
  (let ((u (and (json-object-p m) (equal (json-get m "role") "assistant") (json-get m "usage"))))
    (when (truthy-p u)
      (let ((n (+ (number-or-zero (json-get u "input")) (number-or-zero (json-get u "cacheRead")) (number-or-zero (json-get u "cacheWrite")))))
        (and (> n 0) n)))))
