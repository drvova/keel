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
import { join } from "path";
import { forEachJsonlLine } from "./jsonl";
import { clip, textOf } from "./content";
import { PIN_ENTRY_TYPE, formatPin, readPins } from "./pins";

export interface SessionInfo {
  file: string;
  id: string;
  /** The id's first 8 characters: what output shows and session:'…' takes. */
  short: string;
  /** Header timestamp (session start), ISO. */
  started?: string;
  modifiedMs: number;
  bytes: number;
  messages: number;
  title?: string;
  firstRequest?: string;
  /** The session's pinned notes, formatted. */
  pins: string[];
}

/** Sessions listed at most; the newest are kept. */
export const MAX_LISTED_SESSIONS = 50;

const MESSAGE_PREFIX = Buffer.from('{"type":"message"');

const startsWith = (line: Buffer, prefix: Buffer): boolean =>
  line.length >= prefix.length && line.subarray(0, prefix.length).equals(prefix);

const lineHas = (line: Buffer, needle: string): boolean => line.includes(needle);

const parse = (line: Buffer): any => {
  try { return JSON.parse(line.toString("utf8")); } catch { return undefined; }
};

/**
 * One pass over a session file: header, message count, first user request,
 * title, pins. Only the lines those need are parsed; the rest are counted by
 * their prefix (both hosts write `{"type":"message",…}` first).
 */
export const scanSession = (file: string): SessionInfo | undefined => {
  let stat;
  try { stat = statSync(file); } catch { return undefined; }
  let header: any;
  let title: string | undefined;
  let firstRequest: string | undefined;
  let messages = 0;
  let lineNo = 0;
  const pinEntries: any[] = [];
  try {
    forEachJsonlLine(file, (line) => {
      lineNo++;
      if (line.length === 0) return;
      if (startsWith(line, MESSAGE_PREFIX)) {
        messages++;
        if (firstRequest === undefined && lineHas(line, '"role":"user"')) {
          const text = textOf(parse(line)?.message?.content ?? "").replace(/\s+/g, " ").trim();
          if (text && !text.startsWith("<")) firstRequest = clip(text, 100);
        }
        return;
      }
      if (lineNo <= 3 && !header) {
        const e = parse(line);
        if (e?.type === "session" && typeof e.id === "string") header = e;
        else if (e?.type === "title" && typeof e.title === "string" && e.title.trim()) title = e.title.trim();
        return;
      }
      if (lineHas(line, PIN_ENTRY_TYPE) || lineHas(line, '"reset_boundary"')) {
        const e = parse(line);
        if (e?.type === "custom" || e?.type === "reset_boundary") pinEntries.push(e);
        return;
      }
      if (lineHas(line, '"title_change"')) {
        const e = parse(line);
        if (e?.type === "title_change" && typeof e.title === "string" && e.title.trim()) title = e.title.trim();
      }
    });
  } catch {
    return undefined;
  }
  if (!header) return undefined;
  return {
    file,
    id: header.id,
    short: header.id.replace(/-/g, "").slice(0, 8),
    started: typeof header.timestamp === "string" ? header.timestamp : undefined,
    modifiedMs: stat.mtimeMs,
    bytes: stat.size,
    messages,
    ...(title ? { title: clip(title, 80) } : {}),
    ...(firstRequest ? { firstRequest } : {}),
    pins: readPins(pinEntries).map(formatPin),
  };
};

const sameFile = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/** The project's other sessions, newest first (by last write). */
export const listProjectSessions = (dir: string, currentFile?: string, limit = MAX_LISTED_SESSIONS): SessionInfo[] => {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const files = names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(dir, n))
    .filter((f) => !currentFile || !sameFile(f, currentFile))
    .map((f) => { try { return { f, mtime: statSync(f).mtimeMs }; } catch { return undefined; } })
    .filter((x): x is { f: string; mtime: number } => !!x)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  return files.map((x) => scanSession(x.f)).filter((s): s is SessionInfo => !!s);
};

/** "01a194d8", "@01a1", "session:01a194d8-…" -> the one session it names, or why not. */
export const resolveSession = (ref: string, sessions: readonly SessionInfo[]): SessionInfo | { error: string } => {
  const key = ref.trim().replace(/^(?:@|session:)/i, "").replace(/-/g, "").toLowerCase();
  if (key.length < 4) return { error: `session:'${ref}' is too short: give at least 4 characters of an id from mode:'sessions'.` };
  const matches = sessions.filter((s) => s.id.replace(/-/g, "").toLowerCase().startsWith(key));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    return { error: `No earlier session of this project starts with '${ref}'. mode:'sessions' lists them.` };
  }
  return { error: `session:'${ref}' matches ${matches.length} sessions (${matches.map((s) => s.short).join(", ")}): give more of the id.` };
};

/** The ids on a session file's active branch: its last entry back to the root. */
export const fileBranchIds = (file: string): Set<string> | undefined => {
  const parentOf = new Map<string, string | null>();
  let last: string | undefined;
  forEachJsonlLine(file, (line) => {
    if (line.length === 0) return;
    // id and parentId come before the payload on both hosts; parse only the head.
    const head = line.subarray(0, Math.min(line.length, 400)).toString("utf8");
    const id = head.match(/"id":"([^"]+)"/)?.[1];
    if (!id || head.startsWith('{"type":"session"') || head.startsWith('{"type":"title"')) return;
    const parent = head.match(/"parentId":(?:"([^"]+)"|null)/);
    parentOf.set(id, parent ? parent[1] ?? null : null);
    last = id;
  });
  if (!last) return undefined;
  const ids = new Set<string>();
  for (let id: string | null | undefined = last; id && !ids.has(id); id = parentOf.get(id)) ids.add(id);
  return ids;
};

const date = (iso?: string): string => (iso ? iso.replace("T", " ").slice(0, 16) : "unknown start");

export const describeSession = (s: SessionInfo): string =>
  `${s.short} · ${date(s.started)} · ${s.messages} messages${s.title ? ` · ${s.title}` : ""}${s.firstRequest ? ` · "${s.firstRequest}"` : ""}`;
