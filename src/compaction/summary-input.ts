// What each live message becomes in a summary's input: the one mapping behind
// both the summary and the cut's "would this prefix render" check, so the two
// cannot disagree.
import { normalize } from "../core/normalize";
import { UNSUMMARIZED_MESSAGE_TYPES } from "../names";

import type { ConvertToLlm } from "../host";
export type { ConvertToLlm } from "../host";

export interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

/** The host's convertToLlm for one message, as the summarizer input path runs it:
 * a message it rejects or drops yields []. */
const toLlmSafe = (message: unknown, convert: ConvertToLlm): any[] => {
  try {
    return convert([message as any]);
  } catch {
    return [];
  }
};

/**
 * One live message as the summarizer reads it, or null when it adds nothing.
 * The single mapping behind both the summary input and the "would the prefix
 * render" check, so the two cannot disagree.
 *
 * - A user-run `!cmd` (bashExecution) and omp's user-run python cell stay as they
 *   are: the brief shows each as one line, with the output behind `vcc_recall`.
 *   convertToLlm would turn them into user text.
 * - An extension's custom_message, and user text an extension sent on the agent's
 *   behalf (omp `attribution: "agent"`), are marked `injected` so the early
 *   requests and [User Messages] read only what the user wrote. omp converts a
 *   custom message to a developer message; it is read back as user content.
 * - omp's developer-role turns (host reminders) and @file mention contents are
 *   host context, not conversation, and are left out, as is the notice
 *   /omp-vcc-pin sends the agent ([Pinned Notes] carries the note itself).
 */
export const toSummaryMessage = (message: any, convert: ConvertToLlm): any | null => {
  const role = message?.role;
  if (role === "developer" || role === "fileMention") return null;
  if (role === "custom" && UNSUMMARIZED_MESSAGE_TYPES.has(message.customType)) return null;
  const converted = toLlmSafe(message, convert);
  if (converted.length === 0) return null;
  if (role === "bashExecution" || role === "pythonExecution") return message;
  if (role === "custom") return { ...converted[0], role: "user", injected: true };
  if (role === "user" && message.attribution === "agent") return { ...converted[0], injected: true };
  return converted[0];
};

/** A custom_message the user listed in skipCustomTypes; dropped before summarizing. */
export const isSkippedCustom = (m: any, skipCustomTypes: readonly string[]): boolean =>
  m?.role === "custom" && skipCustomTypes.includes(m?.customType);

/**
 * The summary's input from these messages (`ids` parallel): the custom types
 * the user listed in skipCustomTypes left out, the rest each as
 * toSummaryMessage makes it, ids kept aligned (convertToLlm works one message
 * at a time, so never by position). `summarized` counts what the summary
 * covers, before toSummaryMessage drops what adds nothing.
 */
export const summaryInputOf = (
  messages: readonly any[],
  ids: readonly string[],
  skipCustomTypes: readonly string[],
  convert: ConvertToLlm,
): { summarized: number; messages: any[]; ids: string[] } => {
  const out = { summarized: 0, messages: [] as any[], ids: [] as string[] };
  messages.forEach((m, i) => {
    if (isSkippedCustom(m, skipCustomTypes)) return;
    out.summarized++;
    const message = toSummaryMessage(m, convert);
    if (message == null) return;
    out.messages.push(message);
    out.ids.push(ids[i]);
  });
  return out;
};

/** True when the prefix would contribute at least one block to the summary.
 * Runs the same path as the summarizer (skipCustomTypes filter, toSummaryMessage,
 * normalize): custom_message and branch_summary become user content and render,
 * while role "system" passes through unchanged and renders nothing. */
export const prefixHasRenderableContent = (
  prefix: EntryWithMessage[],
  skipCustomTypes: readonly string[],
  convert: ConvertToLlm,
): boolean =>
  normalize(summaryInputOf(prefix.map((m) => m.message), prefix.map((m) => m.entry.id), skipCustomTypes, convert).messages).length > 0;

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, as omp's session context builds
// them when it replays the branch.
export const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
  if (entry.type === "message" && entry.message) return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      ...(entry.attribution !== undefined ? { attribution: entry.attribution } : {}),
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      content: undefined,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  return null;
};
