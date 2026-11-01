// A real omp session file's active-branch messages, read the way omp replays
// them: omp's own parser (title slot and all) and context builder.
import { readFileSync } from "fs";
import type { Message } from "@oh-my-pi/pi-ai";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";

export interface LoadedSession {
  messageCount: number;
  skippedCount: number;
  messages: Message[];
}

export const loadSessionMessages = (file: string): LoadedSession => {
  const entries = parseSessionEntries(readFileSync(file, "utf8"));
  const sessionEntries = entries.filter((entry: any) => entry.type !== "session");
  const context = buildSessionContext(sessionEntries as any);
  const messages = (context.messages as any[]).filter(
    (msg): msg is Message =>
      msg && typeof msg.role === "string" && "content" in msg,
  );
  return {
    messageCount: messages.length,
    skippedCount: context.messages.length - messages.length,
    messages,
  };
};
