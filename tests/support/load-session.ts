// A real session file's active-branch messages, read the way its host replays
// them: omp's own parser (title slot and all) and context builder, or Pi's.
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

/** A Pi session file, read with Pi's own parser and context builder (its migrations and context edits applied). */
export const loadPiSessionMessages = async (file: string): Promise<LoadedSession> => {
  const pi: any = await import("@earendil-works/pi-coding-agent" as string);
  const entries = pi.parseSessionEntries(readFileSync(file, "utf8"));
  pi.migrateSessionEntries(entries);
  const sessionEntries = entries.filter((entry: any) => entry.type !== "session");
  const context = pi.buildSessionContext(sessionEntries);
  const messages = (context.messages as any[]).filter((msg): msg is Message => msg && typeof msg.role === "string" && "content" in msg);
  return { messageCount: messages.length, skippedCount: context.messages.length - messages.length, messages };
};
