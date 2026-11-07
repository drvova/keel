;;;; tools.lisp --- tests: how a tool call's file is read (render.lisp, blocks.lisp, working-set.lisp).
;;;;
;;;; SPDX-License-Identifier: MIT

(in-package #:omp-vcc.test)

(defun read-of (path)
  (make-ws-call "t" "read" (parse-json (format nil "{\"path\":~a}" (json-string path))) (list path) 0))

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
