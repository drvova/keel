;;;; tools.lisp --- tests: how a tool call's file is read and what its results leave open (render.lisp, blocks.lisp, calls.lisp).
;;;;
;;;; SPDX-License-Identifier: MIT

(in-package #:keel.test)

(defun read-of (path)
  (make-call "read" (parse-json (format nil "{\"path\":~a}" (json-string path))) "t" 0))

(deftest a-read-of-lines-is-a-read-of-part-of-the-file
  (dolist (p '("src/a.ts:50-100" "src/a.ts:L50-L60" "src/a.ts:-20" "src/a.ts:1-12,-15" "src/a.ts:raw:50-100" "src/a.ts:50+10"))
    (is (reads-part-p (read-of p)) p))
  ;; :raw and a whole read are not.
  (dolist (p '("src/a.ts" "src/a.ts:raw" "src/a.ts:img" "db.sqlite:table"))
    (is (not (reads-part-p (read-of p))) p)))

(deftest read-selectors-are-dropped-other-colons-kept
  (is (equal (strip-read-selector "src/a.ts:50-100") "src/a.ts"))
  (is (equal (strip-read-selector "src/a.ts:raw") "src/a.ts"))
  (is (equal (strip-read-selector "src/a.ts:-20") "src/a.ts"))
  (is (equal (strip-read-selector "src/a.ts:1-12,-15") "src/a.ts"))
  (is (equal (strip-read-selector "db.sqlite:table") "db.sqlite:table"))
  (is (equal (strip-read-selector "src/a.ts") "src/a.ts")))

;;; calls.lisp: which failure is still open.

(defun tool-turn (id name path)
  (parse-json (format nil "{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":~a,\"name\":~a,\"arguments\":{\"path\":~a}}]}"
                      (json-string id) (json-string name) (json-string path))))

(defun tool-answer (id text error)
  (parse-json (format nil "{\"role\":\"toolResult\",\"toolCallId\":~a,\"content\":~a,\"isError\":~:[false~;true~]}"
                      (json-string id) (json-string text) error)))

(deftest a-fixed-failure-leaves-an-earlier-one-open
  ;; a.ts fails and stays failed; b.ts fails later and is fixed: a.ts's failure is the open one.
  (let ((messages (list (tool-turn "1" "edit" "a.ts") (tool-answer "1" "a failed" t)
                        (tool-turn "2" "edit" "b.ts") (tool-answer "2" "b failed" t)
                        (tool-turn "3" "edit" "b.ts") (tool-answer "3" "b ok" nil))))
    (let ((open (open-failures (nth-value 1 (read-calls messages :indices '(0 1 2 3 4 5))))))
      (is (equal (mapcar #'result-text open) '("a failed")))
      (is (eql (result-index (first open)) 1)))))

(deftest a-later-success-of-the-same-run-fixes-a-failure
  (let ((messages (list (tool-turn "1" "edit" "a.ts") (tool-answer "1" "failed" t)
                        (tool-turn "2" "edit" "a.ts") (tool-answer "2" "ok" nil))))
    (is (null (open-failures (nth-value 1 (read-calls messages)))))))
