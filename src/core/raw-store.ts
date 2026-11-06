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
// omp's settings needs changing for it.
import { appendFileSync } from "fs";
import { forEachJsonlLine } from "./jsonl";
import { sessionLineage } from "./session-file";

const RAW_STORE_SUFFIX = ".vcc-raw";

export const rawStorePath = (sessionFile: string): string => sessionFile + RAW_STORE_SUFFIX;

/** omp shakes fenced and XML blocks of 400+ tokens out of a message's text: about this many chars. */
const SHAKEABLE_TEXT_CHARS = 1_200;
/** One message's kept text is clipped here, so a stray multi-megabyte result cannot double the session's size alone. */
export const MAX_KEPT_CHARS = 1_000_000;

type Part = Record<string, unknown>;

const parts = (content: unknown): Part[] =>
  Array.isArray(content) ? content.filter((p): p is Part => !!p && typeof p === "object" && !Array.isArray(p)) : [];

const textLength = (content: unknown): number =>
  typeof content === "string" ? content.length : parts(content).reduce((n, p) => n + (p.type === "text" && typeof p.text === "string" ? p.text.length : 0), 0);

/** omp may rewrite this message later: tool output, or text long enough to hold a block omp shakes. */
export const mayBeRewritten = (message: unknown): boolean => {
  const m = message as { role?: unknown; content?: unknown; prunedAt?: unknown } | undefined;
  if (!m || m.prunedAt !== undefined) return false;
  if (m.role === "toolResult") return textLength(m.content) > 0;
  if (m.role === "assistant" || m.role === "user" || m.role === "developer") {
    return typeof m.content === "string"
      ? m.content.length >= SHAKEABLE_TEXT_CHARS
      : parts(m.content).some((p) => p.type === "text" && typeof p.text === "string" && p.text.length >= SHAKEABLE_TEXT_CHARS);
  }
  return false;
};

/** What is kept of a message's content: its text (clipped) and other parts as they are, images without their data. */
export const keptContent = (content: unknown): unknown => {
  let budget = MAX_KEPT_CHARS;
  const clip = (text: string): string => {
    if (text.length <= budget) {
      budget -= text.length;
      return text;
    }
    const kept = `${text.slice(0, budget)}\n...[omp-vcc kept the first ${budget} of ${text.length} chars]`;
    budget = 0;
    return kept;
  };
  if (typeof content === "string") return clip(content);
  return parts(content).map((p) => {
    if (p.type === "text" && typeof p.text === "string") return { ...p, text: clip(p.text) };
    if (p.type === "image") {
      const { data: _data, ...rest } = p;
      return rest;
    }
    return p;
  });
};

export interface RawRecord {
  id: string;
  content: unknown;
}

export const appendRawStore = (sessionFile: string, records: RawRecord[]): void => {
  if (records.length === 0) return;
  // `id` first, whatever the caller built: the scans below read it from each line's start.
  appendFileSync(rawStorePath(sessionFile), records.map((r) => JSON.stringify({ id: r.id, content: r.content })).join("\n") + "\n");
};

const ID_AT_START = /^\{"id":"((?:[^"\\]|\\.)*)"/;

/** The entry ids the store holds, read from each line's start. */
export const rawStoreIds = (sessionFile: string): Set<string> => {
  const ids = new Set<string>();
  try {
    forEachJsonlLine(rawStorePath(sessionFile), (line) => {
      const m = line.subarray(0, 512).toString("utf8").match(ID_AT_START);
      if (m) ids.add(JSON.parse(`"${m[1]}"`));
    });
  } catch {}
  return ids;
};

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
