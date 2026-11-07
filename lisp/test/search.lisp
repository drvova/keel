;;;; search.lisp --- tests: stems, the regex hand-off, and ranking basics.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Hit-for-hit agreement with search-entries.ts is tests/lisp-core.test.ts's;
;;;; these pin what that comparison would only show as a mismatch.

(in-package #:omp-vcc.test)

(defun docs (&rest texts)
  (coerce (loop for text in texts collect (list "user" text '())) 'vector))

(deftest stems
  (is (equal (stem-of "stopping") "stop"))
  (is (equal (stem-of "rounding") "round"))
  (is (null (stem-of "test")) "too short to stem")
  (is (null (stem-of "café")) "only plain ASCII words are stemmed"))

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
