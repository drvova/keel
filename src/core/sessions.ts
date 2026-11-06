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
import { readdirSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";
import { readHeader, scanLines } from "./session-file";
import { clip, isExtensionUserMessage, textOf } from "./content";
import { userWords } from "../extract/user-messages";
import { formatPin, readPins, replaysPins } from "./pins";

export interface SessionInfo {
  file: string;
  id: string;
  /** The id's first 8 characters: what output shows and session:'…' takes. */
  short: string;
  /** Header timestamp (session start), ISO. */
  started?: string;
  bytes: number;
  messages: number;
  title?: string;
  firstRequest?: string;
  /** The session's pinned notes, formatted. */
  pins: string[];
}

/** The shortest id prefix that names a session. */
export const SESSION_REF_MIN_CHARS = 4;

/** Sessions listed at most; the newest are kept. */
export const MAX_LISTED_SESSIONS = 50;

const parse = (line: Buffer): any => {
  try { return JSON.parse(line.toString("utf8")); } catch { return undefined; }
};

/**
 * A session's name as each host writes it: omp's title slot (its first line,
 * rewritten in place) and renames, `title`; Pi's `/name`, a session_info entry's
 * `name` (docs/session-format.md). The latest wins.
 */
const nameOf = (e: any): string | undefined => {
  const name = e?.type === "title" || e?.type === "title_change" ? e.title : e?.type === "session_info" ? e.name : undefined;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
};

/**
 * One pass over a session file: header, message count, first user request,
 * title, pins (replayed along its active branch). Only the lines those need
 * are parsed (compactions, the bulk of the rest, never); messages are read by
 * their heads (session-file.ts entryHead).
 */
const scanSession = (file: string): SessionInfo | undefined => {
  let stat;
  try { stat = statSync(file); } catch { return undefined; }
  const header = readHeader(file);
  if (typeof header?.id !== "string") return undefined;
  let title: string | undefined;
  let firstRequest: string | undefined;
  let messages = 0;
  // What readPins replays, with their ids, to replay along the branch.
  const pinEntries: any[] = [];
  let branch: Set<string> | undefined;
  try {
    branch = scanLines(file, (line, head) => {
      if (head.type === "message") {
        messages++;
        if (firstRequest === undefined && line.includes('"role":"user"')) {
          const m = parse(line)?.message;
          // What the user wrote, as the summary reads it; not what an extension sent as the user.
          const words = m?.role === "user" && !isExtensionUserMessage(m) ? userWords(textOf(m.content ?? "")).words : "";
          if (words) firstRequest = clip(words, 100);
        }
        return;
      }
      // A compaction's summary is the bulk of what is left; nothing here reads it.
      if (head.type === "compaction") return;
      const e = parse(line);
      if (replaysPins(e)) pinEntries.push(e);
      else title = nameOf(e) ?? title;
    });
  } catch {
    return undefined;
  }
  const onBranch = branch?.size ? pinEntries.filter((e) => typeof e.id === "string" && branch!.has(e.id)) : pinEntries;
  return {
    file,
    id: header.id,
    short: header.id.replace(/-/g, "").slice(0, 8),
    started: typeof header.timestamp === "string" ? header.timestamp : undefined,
    bytes: stat.size,
    messages,
    ...(title ? { title: clip(title, 80) } : {}),
    ...(firstRequest ? { firstRequest } : {}),
    pins: readPins(onBranch).map(formatPin),
  };
};

const sameFile = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/** The project's other session files, newest first (by last write). */
const projectFiles = (dir: string, currentFile?: string): string[] => {
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

/** The project's other sessions, newest first, from its newest `limit` session files; `more` when there are older files. */
export const listProjectSessions = (dir: string, currentFile?: string, limit = MAX_LISTED_SESSIONS): SessionInfo[] & { more: boolean } => {
  const files = projectFiles(dir, currentFile);
  return Object.assign(files.slice(0, limit).map(scanSession).filter((s): s is SessionInfo => !!s), { more: files.length > limit });
};

/** The project's other session files with their ids, newest first, read from each file's header alone. */
const projectIds = (dir: string, currentFile?: string): Array<{ file: string; id: string; short: string }> =>
  projectFiles(dir, currentFile).flatMap((file) => {
    const id = readHeader(file)?.id;
    return typeof id === "string" ? [{ file, id, short: id.replace(/-/g, "").slice(0, 8) }] : [];
  });

/** How many other sessions the project has. */
export const countProjectSessions = (dir: string, currentFile?: string): number => projectIds(dir, currentFile).length;

/**
 * An id prefix ("01a194d8", "01a1", "01a194d8-…"; core/recall-request.ts
 * sessionRef strips "@"/"session:") -> the one of these sessions it names, or why not.
 */
export const resolveSession = <S extends { id: string; short: string }>(ref: string, sessions: readonly S[]): S | { error: string } => {
  const key = ref.replace(/-/g, "").toLowerCase();
  if (key.length < SESSION_REF_MIN_CHARS) return { error: `session:'${ref}' is too short: give at least ${SESSION_REF_MIN_CHARS} characters of an id from mode:'sessions'.` };
  const matches = sessions.filter((s) => s.id.replace(/-/g, "").toLowerCase().startsWith(key));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    return { error: `No earlier session of this project starts with '${ref}'. mode:'sessions' lists them.` };
  }
  return { error: `session:'${ref}' matches ${matches.length} sessions (${matches.map((s) => s.short).join(", ")}): give more of the id.` };
};

/** The earlier session an id prefix names, among every one of the project's (by header), read whole once found. */
export const findSession = (dir: string, currentFile: string, ref: string): SessionInfo | { error: string } => {
  const found = resolveSession(ref, projectIds(dir, currentFile));
  if ("error" in found) return found;
  return scanSession(found.file) ?? { error: `Session ${found.short} could not be read.` };
};

const date = (iso?: string): string => (iso ? iso.replace("T", " ").slice(0, 16) : "unknown start");

export const describeSession = (s: SessionInfo): string =>
  `${s.short} · ${date(s.started)} · ${s.messages} messages${s.title ? ` · ${s.title}` : ""}${s.firstRequest ? ` · "${s.firstRequest}"` : ""}`;

/** The current session's project directory: the host's, else the session file's own. */
export const sessionDirOf = (sessionManager: { getSessionDir?(): string | undefined }, sessionFile: string): string => {
  try {
    const dir = sessionManager.getSessionDir?.();
    if (typeof dir === "string" && dir) return dir;
  } catch {}
  return dirname(sessionFile);
};
