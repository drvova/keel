import type { Message } from "@oh-my-pi/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";
import { isObject, readableMessage } from "./content";
import { forEachJsonlLine } from "./jsonl";
import { isCountedMessageEntry } from "./global-indices";

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

  return { rendered, rawMessages };
};
