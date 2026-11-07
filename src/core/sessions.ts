// The project's other sessions, for cross-session recall.
//
// A long task outlives one session: a restart, /new, a fork, an omp handoff or
// a sibling move starts a new session file, and recall over the current file
// alone loses everything before it. omp and Pi each keep one directory of
// session files per working directory (~/.omp/agent/sessions/<cwd>/,
// ~/.pi/agent/sessions/--<cwd>--/), so "this project's
// earlier sessions" is that directory minus the current file. Each is read the way the current one is:
// its active branch (its last entry back to the root), with `#N` in its own
// index space.
// The core lists, resolves and reads them (lisp/src/sessions.lisp); what it
// needs of the host is here: the directory, and its files newest first.
import { readdirSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";

const sameFile = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/** The project's other session files, newest first (by last write). */
export const projectFiles = (dir: string, currentFile?: string): string[] => {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(dir, n))
    .filter((f) => !currentFile || !sameFile(f, currentFile))
    .map((f) => { try { return { f, mtime: statSync(f).mtimeMs }; } catch { return undefined; } })
    .filter((x): x is { f: string; mtime: number } => !!x)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
};

/** The directory the session manager keeps this project's sessions in, or else the session file's. */
export const sessionDirOf = (sessionManager: { getSessionDir?(): string | undefined }, sessionFile: string): string => {
  try {
    const dir = sessionManager.getSessionDir?.();
    if (typeof dir === "string" && dir) return dir;
  } catch {}
  return dirname(sessionFile);
};
