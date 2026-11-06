// The messages recall reads from a session file: every message entry with its
// `#N` (session-file.ts), readable whatever the file holds, and with what omp
// rewrote in place put back from the originals omp-vcc kept (raw-store.ts).
import type { Message } from "@oh-my-pi/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";
import { isObject, readableMessage } from "./content";
import { activeBranchIds, indexedMessages, readEntries } from "./session-file";
import { restoreOriginals } from "./raw-store";

export interface RecallMessage {
  index: number;
  id: string | undefined;
  message: Message;
}

/** A session file as recall reads it, once per call. */
export interface SessionRead {
  /**
   * Every message recall can show, with its `#N`. A system message (the host's
   * prompt and tool loadout) holds a `#N` but is not conversation; an entry
   * that cannot be read is left out, its `#N` still taken.
   */
  messages: RecallMessage[];
  /** The file's active branch: its last entry back to the root. */
  branchIds: Set<string>;
}

export const readSession = (file: string): SessionRead => {
  const entries = readEntries(file) ?? [];
  const indexed = indexedMessages(entries).filter((m) => isObject(m.message) && m.message.role !== "system");
  const restored = restoreOriginals(indexed.map((m) => m.message), indexed.map((m) => m.id), file);
  const messages: RecallMessage[] = [];
  indexed.forEach((m, i) => {
    try { messages.push({ index: m.index, id: m.id, message: readableMessage(restored[i]) }); } catch {}
  });
  return { messages, branchIds: activeBranchIds(entries) };
};

/** A message as recall shows it (`entry`, with its #N) and as it is (`message`). */
export interface LoadedEntry {
  entry: RenderedEntry;
  message: Message;
}

/**
 * Messages as recall shows them, only those in `allowed` when it is given:
 * `full` is expand's view, `detailChars` its clip for one call's arguments
 * (render-entries.ts EXPAND_DETAIL_CHARS).
 */
export const renderMessages = (
  messages: readonly RecallMessage[],
  full: boolean,
  allowed?: ReadonlySet<string>,
  detailChars?: number,
): LoadedEntry[] => {
  const out: LoadedEntry[] = [];
  for (const m of messages) {
    if (allowed && !(m.id && allowed.has(m.id))) continue;
    // One message that cannot be rendered is left out, not the session.
    try { out.push({ entry: renderMessage(m.message, m.index, full, detailChars), message: m.message }); } catch {}
  }
  return out;
};

export const loadAllMessages = (file: string, full: boolean, allowed?: ReadonlySet<string>, detailChars?: number): LoadedEntry[] =>
  renderMessages(readSession(file).messages, full, allowed, detailChars);
