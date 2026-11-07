;;;; js-string.lisp --- tests: JavaScript's lengths, slices and whitespace.
;;;;
;;;; SPDX-License-Identifier: MIT

(in-package #:omp-vcc.test)

(deftest emoji-is-two-code-units
  (is (= 2 (js-length (string (code-char #x1F389)))))
  (is (= 5 (js-length (format nil "ab~cc" (code-char #x1F389))))))

(deftest slice-cuts-a-pair-as-javascript-does
  (let ((s (format nil "a~cb" (code-char #x1F389))))
    (is (string= (js-slice s 0 4) s))
    (is (string= (js-slice s 0 1) "a"))
    (is (= #xD83C (char-code (char (js-slice s 0 2) 1))) "the high surrogate is left when the cut is inside the pair")
    (is (= #xDF89 (char-code (char (js-slice s 2 4) 0))) "the low surrogate is left from the middle")
    (is (string= (js-slice s 3) "b"))))

(deftest split-whitespace-keeps-empty-edges
  (is (equal (js-split-whitespace "a  b") '("a" "b")))
  (is (equal (js-split-whitespace " a") '("" "a")))
  (is (equal (js-split-whitespace "a ") '("a" "")))
  (is (equal (js-split-whitespace "") '("")))
  (is (equal (js-split-whitespace (format nil "a~cb" (code-char #x3000))) '("a" "b")) "ideographic space is \\s"))

(deftest trim-uses-javascripts-set
  (is (string= (js-trim (format nil "~c x ~c" (code-char #xFEFF) (code-char #xA0))) "x")))

(defun folds-together-p (a b) (char= (js-canonical a) (js-canonical b)))

(deftest case-folding-follows-non-unicode-i
  (is (folds-together-p #\a #\A))
  (is (folds-together-p #\я #\Я))
  (is (not (folds-together-p (code-char #x131) #\i)) "dotless i does not fold to ASCII")
  (is (not (folds-together-p (code-char #x17F) #\s)) "long s does not fold to ASCII"))
