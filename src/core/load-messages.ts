import type { Message } from "@oh-my-pi/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";
import { isObject, readableMessage } from "./content";
import { forEachJsonlLine } from "./jsonl";
import { isCountedMessageEntry } from "./global-indices";
import { readRawStore, wasRewritten, withOriginalContent } from "./raw-store";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
  /** The full view's clip for one call's arguments (render-entries.ts EXPAND_DETAIL_CHARS). */
  detailChars?: number,
): LoadedMessages => {
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  let messageIndex = 0;
  // Entries omp rewrote in place (core/raw-store.ts): rendered again from the
  // originals omp-vcc kept, once the file is read.
  const rewritten: Array<{ pos: number; id: string; message: Record<string, unknown>; index: number }> = [];

  const processLine = (line: Buffer) => {
    if (line.length === 0) return;
    let entry: any;
    try { entry = JSON.parse(line.toString("utf8")); } catch { return; }
    // Counting rule shared with src/core/global-indices.ts — both index
    // spaces must agree by construction.
    if (!isCountedMessageEntry(entry)) return;

    // A `role: "system"` message entry (host prompt/tool loadout) still
    // occupies a `#N` index (shared counting rule) but is not conversation
    // content, so recall never renders or searches it.
    const allowed = (!allowedEntryIds || allowedEntryIds.has(entry.id))
      && entry.message.role !== "system";
    if (allowed) {
      // An entry that still cannot be rendered is left out, not the session:
      // its #N stays taken, so every other ref still resolves.
      try {
        if (!isObject(entry.message)) throw new Error("not a message");
        const message = readableMessage(entry.message);
        const view = renderMessage(message, messageIndex, full, detailChars);
        if (typeof entry.id === "string" && wasRewritten(entry.message)) {
          rewritten.push({ pos: rendered.length, id: entry.id, message: entry.message, index: messageIndex });
        }
        rendered.push(view);
        rawMessages.push(message);
      } catch {}
    }
    messageIndex++;
  };

  // Streamed via forEachJsonlLine: large sessions can exceed V8's maximum
  // string length before parsing even starts. A missing file yields an empty
  // result — omp does not create a new session's JSONL until its first
  // persisted entry.
  forEachJsonlLine(sessionFile, processLine);

  if (rewritten.length > 0) {
    const kept = readRawStore(sessionFile, new Set(rewritten.map((r) => r.id)));
    for (const r of rewritten) {
      if (!kept.has(r.id)) continue;
      try {
        const message = readableMessage(withOriginalContent(r.message, kept.get(r.id)));
        rendered[r.pos] = renderMessage(message, r.index, full, detailChars);
        rawMessages[r.pos] = message;
      } catch {}
    }
  }

  return { rendered, rawMessages };
};
