;;;; context-edits.lisp --- Pi's append-only context edits, applied as Pi applies them.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; A port of src/core/context-edits.ts (itself a port of Pi's
;;;; buildSessionProjection / projectContextEntry). Pi never rewrites an entry:
;;;; a later `context_edit` entry omits an earlier one from the model's context
;;;; (`replacement: null`) or swaps its content, keeping its role and metadata.
;;;; A compaction reads the branch as the context holds it; recall reads the raw
;;;; file. omp writes no edits, so an omp branch comes back as it is.

(in-package #:omp-vcc)

(defparameter +editable-roles+ '("user" "assistant" "toolResult" "custom")
  "The roles whose content a replacement changes (Pi's projectContextEntry).")

(defun context-edit-p (entry)
  (and (equal (json-get entry "type") +context-edit-type+) (stringp (json-get entry "targetId"))))

(defun copy-json-object (object)
  "A shallow copy of OBJECT, its keys in the same order (`{...object}`)."
  (let ((copy (make-hash-table :test 'equal)))
    (maphash (lambda (k v) (setf (gethash k copy) v)) object)
    copy))

(defun with-content (object content)
  "`{...OBJECT, content: CONTENT}`; NIL (undefined) is a key JSON leaves out."
  (let ((copy (copy-json-object object)))
    (if content (setf (gethash "content" copy) content) (remhash "content" copy))
    copy))

(defun replaced-content (role content)
  "A replacement's content for a message of ROLE: a string becomes one text block where Pi's types want blocks."
  (if (and (member role '("assistant" "toolResult") :test #'equal) (stringp content))
      (vector (json-object "type" "text" "text" content))
      content))

(defun project-entry (entry edit)
  "ENTRY as the context holds it under EDIT (NIL for none), or NIL when the edit omits it."
  (cond ((null edit) entry)
        ((eq (json-get edit "replacement") :null) nil)
        (t (let ((content (json-get (json-get edit "replacement") "content"))
                 (message (json-get entry "message")))
             (cond ((and (equal (json-get entry "type") "message") (truthy-p message) (json-object-p message)
                         (member (json-get message "role") +editable-roles+ :test #'equal))
                    (let ((copy (copy-json-object entry)))
                      (setf (gethash "message" copy)
                            (with-content message (replaced-content (json-get message "role") content)))
                      copy))
                   ((equal (json-get entry "type") "custom_message") (with-content entry content))
                   (t entry))))))

(defun apply-context-edits (branch notes)
  "context-edits.ts applyContextEdits on the vector BRANCH, with NOTES (parallel to
it) kept beside each entry left: (values BRANCH NOTES), both as they were when
there are no edits."
  (let ((edits (make-hash-table :test 'equal)))
    (loop for e across branch when (context-edit-p e) do (setf (gethash (json-get e "targetId") edits) e))
    (if (zerop (hash-table-count edits))
        (values branch notes)
        (let ((entries '()) (kept-notes '()))
          (loop for e across branch for i from 0
                unless (context-edit-p e)
                  do (let* ((id (json-get e "id"))
                            (projected (project-entry e (and (stringp id) (gethash id edits)))))
                       (when projected
                         (push projected entries)
                         (push (if (< i (length notes)) (aref notes i) nil) kept-notes))))
          (values (coerce (nreverse entries) 'vector) (coerce (nreverse kept-notes) 'vector))))))
