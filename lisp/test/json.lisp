;;;; json.lisp --- tests: every JSON value reads as one Lisp value and back.
;;;;
;;;; SPDX-License-Identifier: MIT

(in-package #:omp-vcc.test)

(deftest false-null-and-empty-array-stay-apart
  (let ((v (parse-json "{\"f\":false,\"n\":null,\"a\":[],\"t\":true}")))
    (is (eq (json-get v "f") :false))
    (is (eq (json-get v "n") :null))
    (is (equalp (json-get v "a") #()))
    (is (eq (json-get v "t") :true))
    (is (equal (json-string (parse-json "[false,null,[],true]")) "[false,null,[],true]"))))

(deftest numbers
  (is (eql (parse-json "-12") -12))
  (is (eql (parse-json "1.5") 1.5d0))
  (is (eql (parse-json "1e2") 100d0))
  (is (equal (json-string 0.5d0) "0.5")))

(deftest surrogate-pairs-and-lone-surrogates
  (is (string= (parse-json "\"\\ud83c\\udf89\"") (string (code-char #x1F389))))
  (is (= #xD83C (char-code (char (parse-json "\"\\ud83cx\"") 0))))
  (is (string= (json-string (parse-json "\"\\ud83c\"")) "\"\\ud83c\"") "a lone surrogate is written back as its escape"))

(deftest escapes-round-trip
  (let ((s (format nil "q\"b\\n~%t~c~c" #\Tab (code-char 1))))
    (is (string= (parse-json (json-string s)) s))))

(deftest refuses-bad-json
  (dolist (bad '("" "{" "[1,]" "{\"a\"}" "tru" "\"x" "1 2" "01x"))
    (is (handler-case (progn (parse-json bad) nil) (error () t)) (format nil "~s was accepted" bad))))
