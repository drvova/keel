;;;; live.lisp --- the core as one long-lived process.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; `keel-core --serve DIR` answers requests one after another instead of
;;;; one per process: the host process keeps one (src/core.ts), so
;;;; what a request reads stays in memory for the next (a session file parsed
;;;; once, its new lines only after that: JSONL-VALUES in session.lisp), and a
;;;; request costs no process start. The TS side stays synchronous, which is
;;;; why the channel is two named pipes it can read and write with readSync and
;;;; writeSync: DIR/req (one JSON request per line in) and DIR/resp (one JSON
;;;; response per line out), made here.
;;;;
;;;; The order keeps either side from waiting on the other forever: this side
;;;; makes both pipes, opens req for reading and writing (an open that never
;;;; waits, and a reader that never sees the end while the host may write),
;;;; then resp for writing, which waits until the host has opened it for
;;;; reading, then says `ready`. The host waits for that line, bounded, and
;;;; only then opens req for writing. A request that runs past +LIVE-REQUEST-SECONDS+
;;;; is answered as failed; the process ends when the host is gone (its parent
;;;; changed) or after +LIVE-IDLE-SECONDS+ without a request, and the host
;;;; starts another when it next needs one. On Windows, which has no such
;;;; pipes, the host runs one process per request as before.

(in-package #:keel)

(defparameter +live-request-seconds+ 55
  "A request running longer is answered as failed, so the host is never left waiting.")
(defparameter +live-idle-seconds+ 300
  "Without a request for this long the process ends; the host starts another when it needs one.")
(defparameter +live-poll-seconds+ 5
  "How often a waiting process checks the host is still there.")

(defun getppid () (sb-alien:alien-funcall (sb-alien:extern-alien "getppid" (function sb-alien:int))))

(defun mkfifo (path)
  (zerop (sb-alien:alien-funcall (sb-alien:extern-alien "mkfifo" (function sb-alien:int sb-alien:c-string sb-alien:unsigned-int))
                                 path #o600)))

(defun open-fd (path flags)
  (or (sb-unix:unix-open path flags 0) (error "keel's core could not open ~a" path)))

(defun write-all (fd bytes)
  (let ((at 0))
    (sb-sys:with-pinned-objects (bytes)
      (loop while (< at (length bytes))
            do (let ((n (sb-unix:unix-write fd bytes at (- (length bytes) at))))
                 (unless (and n (plusp n)) (return-from write-all nil))
                 (incf at n))))
    t))

(defun serve (dir)
  "Answer requests from DIR/req on DIR/resp until the host is gone or idle too long."
  (let* ((req (concatenate 'string dir "/req")) (resp (concatenate 'string dir "/resp"))
         (parent (getppid)))
    (unless (and (mkfifo req) (mkfifo resp)) (error "keel's core could not make its pipes in ~a" dir))
    (let* ((in (open-fd req sb-unix:o_rdwr))
           (out (open-fd resp sb-unix:o_wronly))
           (buffer (make-array 1048576 :element-type '(unsigned-byte 8)))
           (pending (make-array 0 :element-type '(unsigned-byte 8) :adjustable t :fill-pointer 0))
           (idle 0))
      (write-all out (sb-ext:string-to-octets (format nil "ready~%") :external-format :utf-8))
      (loop
        (cond ((sb-sys:wait-until-fd-usable in :input +live-poll-seconds+)
               (setf idle 0)
               (let ((n (sb-sys:with-pinned-objects (buffer) (sb-unix:unix-read in (sb-sys:vector-sap buffer) (length buffer)))))
                 (unless (and n (plusp n)) (return))
                 (loop for i from 0 below n
                       for byte = (aref buffer i)
                       do (if (= byte 10)
                              (let* ((text (sb-ext:octets-to-string (coerce pending '(simple-array (unsigned-byte 8) (*))) :external-format :utf-8))
                                     (reply (with-output-to-string (s) (write-json (respond text +live-request-seconds+) s) (terpri s))))
                                (setf (fill-pointer pending) 0)
                                (unless (write-all out (sb-ext:string-to-octets reply :external-format :utf-8)) (return-from serve)))
                              (vector-push-extend byte pending)))))
              (t (incf idle +live-poll-seconds+)
                 (when (or (/= (getppid) parent) (>= idle +live-idle-seconds+)) (return))))))))
