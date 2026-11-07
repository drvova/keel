// The host's session manager, as keel reads it: its file, its entry tree and
// the branch it is on. The session file itself is the core's to read
// (lisp/src/session.lisp).

/** What keel reads of the host's session manager; omp's and Pi's ReadonlySessionManager both have it. */
export interface SessionManagerLike {
  getSessionFile?(): string | undefined;
  getEntries?(): any[];
  getBranch?(): any[];
}

/** The host's branch; undefined where it gives none or the call throws (a closed session). */
export const hostBranch = (sessionManager: SessionManagerLike | undefined): any[] | undefined => {
  try {
    const branch = sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : undefined;
  } catch { return undefined; }
};

/** The host's whole entry tree; undefined where it gives none or the call throws. */
export const hostEntries = (sessionManager: SessionManagerLike | undefined): any[] | undefined => {
  try {
    const entries = sessionManager?.getEntries?.();
    return Array.isArray(entries) ? entries : undefined;
  } catch { return undefined; }
};
