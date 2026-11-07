// The originals of what omp rewrites in the session file.
//
// Between compactions omp keeps the live context small by rewriting messages in
// place, and persists the rewrite (SessionManager.rewriteEntries): it blanks old
// tool output (`[Output truncated - N tokens]`), reads a newer read superseded
// and results their tool flagged useless, and shakes tool output and large
// fenced blocks out into `artifact://` files. vcc_recall reads the session
// file as the raw history, so each rewrite would lose what it replaced.
// omp-vcc copies every message omp may rewrite as it lands, from omp's own
// entries (the session file's text, secrets as omp obfuscates them), into
// `<session>.jsonl.vcc-raw` beside it (not a `.jsonl`: omp lists those as
// sessions), and recall reads the copy for the entries omp rewrote. Nothing in
// omp's settings needs changing for it. What is kept and the writing are the
// core's (lisp/src/raw-capture.lisp); this reads the copy back.
import { forEachJsonlLine } from "./jsonl";
import { sessionLineage } from "./session-file";

const RAW_STORE_SUFFIX = ".vcc-raw";

export const rawStorePath = (sessionFile: string): string => sessionFile + RAW_STORE_SUFFIX;

type Part = Record<string, unknown>;

const parts = (content: unknown): Part[] =>
  Array.isArray(content) ? content.filter((p): p is Part => !!p && typeof p === "object" && !Array.isArray(p)) : [];

export interface RawRecord {
  id: string;
  content: unknown;
}

const ID_AT_START = /^\{"id":"((?:[^"\\]|\\.)*)"/;

const readOneStore = (sessionFile: string, wanted: Set<string>, found: Map<string, unknown>): void => {
  try {
    forEachJsonlLine(rawStorePath(sessionFile), (line) => {
      if (line.length === 0 || found.size === wanted.size) return;
      const head = line.subarray(0, 512).toString("utf8").match(ID_AT_START);
      if (!head) return;
      const id = JSON.parse(`"${head[1]}"`);
      if (!wanted.has(id) || found.has(id)) return;
      try {
        const record = JSON.parse(line.toString("utf8")) as RawRecord;
        found.set(id, record.content);
      } catch {}
    });
  } catch {}
};

/**
 * The kept content of these entries (the first copy of each), from the
 * session's store and then its parents': a fork carries its parent's entries
 * (same ids) as they were when it forked, some already rewritten, and their
 * originals are in the parent's store.
 */
export const readRawStore = (sessionFile: string, wanted: Set<string>): Map<string, unknown> => {
  const found = new Map<string, unknown>();
  if (wanted.size === 0) return found;
  readOneStore(sessionFile, wanted, found);
  if (found.size < wanted.size) {
    for (const parent of sessionLineage(sessionFile).slice(1)) {
      readOneStore(parent, wanted, found);
      if (found.size === wanted.size) break;
    }
  }
  return found;
};

const textParts = (content: unknown): string[] =>
  typeof content === "string" ? [content] : parts(content).filter((p) => p.type === "text").map((p) => String(p.text ?? ""));

/**
 * omp rewrote this message in the session file: a tool result it blanked or
 * shook carries `prunedAt`; a text block it shook points at an `artifact://`.
 */
export const wasRewritten = (message: unknown): boolean => {
  const m = message as { role?: unknown; content?: unknown; prunedAt?: unknown } | undefined;
  if (!m) return false;
  if (m.prunedAt !== undefined) return true;
  return m.role !== "toolResult" && textParts(m.content).some((t) => t.includes("artifact://"));
};

/**
 * The message with what omp rewrote put back: a tool result takes the kept
 * content whole; another message takes back each text block that changed,
 * keeping its other parts (tool calls) as they are now.
 */
export const withOriginalContent = <M extends { role?: unknown; content?: unknown }>(message: M, kept: unknown): M => {
  if (kept === undefined) return message;
  if (message.role === "toolResult" || typeof kept === "string" || typeof message.content === "string") {
    const { prunedAt: _prunedAt, ...rest } = message as M & { prunedAt?: unknown };
    return { ...(rest as M), content: kept };
  }
  const keptParts = parts(kept);
  const content = parts(message.content).map((p, i) =>
    p.type === "text" && keptParts[i]?.type === "text" && keptParts[i].text !== p.text ? { ...p, text: keptParts[i].text } : p,
  );
  return { ...message, content };
};

/**
 * These messages with what omp rewrote put back from the kept originals:
 * `ids[i]` is the entry id of `messages[i]`. Messages omp did not rewrite, and
 * ones with no original kept, are returned as they are.
 */
export const restoreOriginals = <M>(messages: M[], ids: ReadonlyArray<string | undefined>, sessionFile: string | undefined): M[] => {
  if (!sessionFile) return messages;
  const wanted = new Set<string>();
  messages.forEach((m, i) => {
    const id = ids[i];
    if (id && wasRewritten(m)) wanted.add(id);
  });
  if (wanted.size === 0) return messages;
  const kept = readRawStore(sessionFile, wanted);
  if (kept.size === 0) return messages;
  return messages.map((m, i) => {
    const id = ids[i];
    return id && kept.has(id) ? withOriginalContent(m as { role?: unknown; content?: unknown }, kept.get(id)) as M : m;
  });
};
