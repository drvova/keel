;;;; search.lisp --- tests: stems, the regex hand-off, and ranking basics.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The TypeScript tests drive the same search through recall
;;;; (tests/search.test.ts); these pin its parts.

(in-package #:keel.test)

(defun docs (&rest texts)
  (coerce (loop for text in texts collect (list "user" text '())) 'vector))

(deftest stems
  (is (equal (stem-of "stopping") "stop"))
  (is (equal (stem-of "rounding") "round"))
  (is (null (stem-of "test")) "too short to stem")
  (is (null (stem-of "café")) "only plain ASCII words are stemmed")
  (is (equal (stem-of "failure") "fail"))
  (is (equal (stem-of "retries") "retr"))
  ;; A doubled final consonant is undone only while the stem stays 4+ letters.
  (is (equal (stem-of "running") "runn"))
  (is (equal (stem-of "committed") "commit"))
  (is (null (stem-of "缓存失败")))
  (is (null (stem-of "auth.*token"))))

(deftest the-recall-cap-is-a-tenth-of-the-window-between-8-and-50-kb
  (is (= (recall-output-chars nil) (* 50 1024)))
  (is (= (recall-output-chars 200000) (* 50 1024)))
  (is (= (recall-output-chars 32000) 12800))
  (is (= (recall-output-chars 8000) (* 8 1024))))

(deftest regex-queries-run-in-entry-order
  (is (equal (mapcar #'car (search-docs "mon.y" (docs "honey" "money" "MONEY" "monkey"))) '(1 2))))

(deftest a-named-group-is-searched-as-javascript-reads-it
  (is (equal (mapcar #'car (search-docs "(?<n>ab)c" (docs "xx" "abc"))) '(1))))

(deftest a-back-reference-into-a-look-behind-is-searched-as-text
  ;; The one construct the regex engine refuses: the query is read literally.
  (is (equal (mapcar #'car (search-docs "(?<=(a)\\1)b" (docs "aab" "x (?<=(a)\\1)b y"))) '(1))))

(deftest an-empty-regex-result-falls-back-to-terms
  ;; "zz.z fix" finds nothing as one regex, so its terms are searched instead.
  (is (equal (mapcar #'car (search-docs "zz.z fix" (docs "fix it" "nothing"))) '(0))))

(deftest empty-query-finds-nothing
  (multiple-value-bind (hits total) (search-docs "   " (docs "anything"))
    (is (null hits))
    (is (= total 0))))

(deftest stem-matches-at-word-start-only
  (let ((hits (search-docs "rounding" (docs "the rounds were off" "surrounds it" "no match"))))
    (is (equal (mapcar #'car hits) '(0)))))

(deftest snippet-marks-lines-around-the-hit
  (let ((hits (search-docs "needle" (docs (format nil "1~%2~%3~%needle~%5~%6~%7")))))
    (is (equal (cdr (first hits)) (format nil "...(1 lines above)~%2~%3~%needle~%5~%6~%...(1 lines below)")))))

(deftest cap-reports-the-count-before-it
  (multiple-value-bind (hits total truncated)
      (search-docs "word" (apply #'docs (loop repeat 60 collect "word")) :cap 50)
    (is (= (length hits) 50))
    (is (= total 60))
    (is truncated)))
