// A session file as omp and Pi write it (omp's session.md, Pi's
// docs/session-format.md): JSONL, one entry per line, written whole and in
// order. The first `session` entry is the header (omp writes a `title` slot
// line before it); every other entry has an `id` and a `parentId`, so the
// entries form a tree and the active branch is the last entry back to the root.
// `#N` numbers the message entries in file order, every branch included, and is
// what summaries cite and vcc_recall resolves. omp's `/clear` appends a
// `reset_boundary`: what is before it on the branch has left the context.
import { closeSync, existsSync, openSync, readdirSync, readSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { forEachJsonlLine } from "./jsonl";

/** What omp-vcc reads of the host's session manager; omp's and Pi's ReadonlySessionManager both have it. */
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

/** omp's `/clear`. */
export const RESET_ENTRY_TYPE = "reset_boundary";

/** An entry `#N` counts: a persisted message. */
export const isCountedEntry = (entry: any): boolean => entry?.type === "message" && entry.message != null;

/** Index of the branch's last `/clear`, -1 for none. */
export const lastResetIndex = (branch: readonly any[]): number => {
  for (let i = branch.length - 1; i >= 0; i--) if (branch[i]?.type === RESET_ENTRY_TYPE) return i;
  return -1;
};

/** The branch since its last `/clear` (all of it without one). */
export const afterReset = <E>(branch: readonly E[]): readonly E[] => branch.slice(lastResetIndex(branch) + 1);

/**
 * `#N` by entry id, for entries in file order. An id seen twice is ambiguous
 * and left out, so a ref is missing rather than wrong.
 */
export const indexById = (entries: readonly any[]): Map<string, number> => {
  const byId = new Map<string, number>();
  const ambiguous = new Set<string>();
  let n = 0;
  for (const entry of entries) {
    if (!isCountedEntry(entry)) continue;
    const id = entry.id;
    if (typeof id === "string" && id) {
      if (byId.has(id) || ambiguous.has(id)) {
        byId.delete(id);
        ambiguous.add(id);
      } else byId.set(id, n);
    }
    n++;
  }
  return byId;
};

/** `#N` of the last message entry. */
export const lastIndex = (entries: readonly any[]): number | undefined => {
  const n = entries.filter(isCountedEntry).length;
  return n > 0 ? n - 1 : undefined;
};

/** The file's entries in order; undefined when it does not exist (a new session's file is written with its first entry). Lines that do not parse are skipped. */
export const readEntries = (file: string): any[] | undefined => {
  const entries: any[] = [];
  const found = forEachJsonlLine(file, (line) => {
    if (line.length === 0) return;
    try { entries.push(JSON.parse(line.toString("utf8"))); } catch {}
  });
  return found ? entries : undefined;
};

/** A message entry with its `#N`. */
interface IndexedMessage {
  index: number;
  id: string | undefined;
  message: Record<string, unknown>;
}

/** The message entries of a file's entries, each with its `#N`. */
export const indexedMessages = (entries: readonly any[]): IndexedMessage[] => {
  const out: IndexedMessage[] = [];
  for (const entry of entries) {
    if (!isCountedEntry(entry)) continue;
    out.push({ index: out.length, id: typeof entry.id === "string" ? entry.id : undefined, message: entry.message });
  }
  return out;
};

/** The ids from `last` back to the root through `parentOf`. */
const pathToRoot = (parentOf: ReadonlyMap<string, string | null>, last: string | undefined): Set<string> => {
  const ids = new Set<string>();
  for (let id: string | null | undefined = last; id && !ids.has(id); id = parentOf.get(id)) ids.add(id);
  return ids;
};

/** The entries the tree is made of: everything but the header and omp's title slot. */
const inTree = (type: unknown): boolean => type !== "session" && type !== "title";

/** The ids on the active branch: the last entry back to the root. Empty for a file without ids (an old format). */
export const activeBranchIds = (entries: readonly any[]): Set<string> => {
  const parentOf = new Map<string, string | null>();
  let last: string | undefined;
  for (const e of entries) {
    if (!inTree(e?.type) || typeof e.id !== "string") continue;
    parentOf.set(e.id, typeof e.parentId === "string" ? e.parentId : null);
    last = e.id;
  }
  return pathToRoot(parentOf, last);
};

/** The ids on the branch the session manager is on (its whole tree when it gives no branch). */
export const currentBranchIds = (sessionManager: SessionManagerLike): Set<string> => {
  const branch = hostBranch(sessionManager);
  const entries = branch?.length ? branch : hostEntries(sessionManager) ?? [];
  return new Set(entries.map((e) => e?.id).filter((id): id is string => typeof id === "string" && id !== ""));
};

/**
 * What a line says without parsing it whole: its type, id and parentId, which
 * both hosts write first. Listing many sessions reads only these.
 */
export const entryHead = (line: Buffer): { type?: string; id?: string; parentId?: string | null } => {
  const head = line.subarray(0, Math.min(line.length, 400)).toString("utf8");
  const type = head.match(/^\{"type":"([^"]+)"/)?.[1];
  const id = head.match(/"id":"([^"]+)"/)?.[1];
  const parent = head.match(/"parentId":(?:"([^"]+)"|null)/);
  return { type, id, ...(parent ? { parentId: parent[1] ?? null } : {}) };
};

/**
 * A scan of a file's lines by their heads: `onLine` sees each non-empty line
 * and its head; the result is the active branch's ids.
 */
export const scanLines = (file: string, onLine: (line: Buffer, head: ReturnType<typeof entryHead>) => void): Set<string> | undefined => {
  const parentOf = new Map<string, string | null>();
  let last: string | undefined;
  const found = forEachJsonlLine(file, (line) => {
    if (line.length === 0) return;
    const head = entryHead(line);
    if (inTree(head.type) && head.id) {
      parentOf.set(head.id, head.parentId ?? null);
      last = head.id;
    }
    onLine(line, head);
  });
  return found ? pathToRoot(parentOf, last) : undefined;
};

const HEADER_BYTES = 64 * 1024;

/** The header, read from the head of the file: the first `session` entry. */
export const readHeader = (file: string): Record<string, unknown> | undefined => {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
      for (const line of buf.subarray(0, n).toString("utf8").split("\n").slice(0, 8)) {
        try {
          const record = JSON.parse(line);
          if (record?.type === "session") return record;
        } catch {}
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
  return undefined;
};

/** The session this one was forked or branched from, as a file: the header's `parentSession`, a path or a session id in the same directory. */
const parentSessionFile = (file: string): string | undefined => {
  const parent = readHeader(file)?.parentSession;
  if (typeof parent !== "string" || !parent) return undefined;
  if (isAbsolute(parent)) return existsSync(parent) ? parent : undefined;
  // omp's files are `<timestamp>_<id>.jsonl`.
  try {
    const dir = dirname(file);
    const name = readdirSync(dir).find((n) => n.endsWith(`_${parent}.jsonl`));
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
};

/** How far up a fork's parents to follow. */
const MAX_PARENTS = 8;

/** The session and the ones it was forked or branched from, nearest first. */
export const sessionLineage = (file: string): string[] => {
  const files = [file];
  for (let parent = parentSessionFile(file); parent && files.length <= MAX_PARENTS && !files.includes(parent); parent = parentSessionFile(parent)) {
    files.push(parent);
  }
  return files;
};
