// What each live message becomes in a summary's input, with the host's own
// convertToLlm: the one part of a compaction the core cannot do (src/compaction/plan.ts hostNotes).
import { isExtensionUserMessage } from "../core/content";
import { PIN_NOTICE_TYPE } from "../names";

import type { ConvertToLlm } from "../host";

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
 *
 * - A user-run `!cmd` (bashExecution) and omp's user-run python cell stay as they
 *   are: the brief shows each as one line, with the output behind `vcc_recall`.
 *   convertToLlm would turn them into user text.
 * - An extension's custom_message, a branch's summary, and user text an
 *   extension sent on the agent's behalf (omp `attribution: "agent"`), are
 *   marked `injected` so the early requests, [User Messages] and [History Index]
 *   read only what the user wrote. omp converts a custom message to a developer
 *   message; it is read back as user content.
 * - omp's developer-role turns (host reminders) and @file mention contents are
 *   host context, not conversation, and are left out, as is the notice
 *   /omp-vcc-pin sends the agent ([Pinned Notes] carries the note itself).
 */
export const toSummaryMessage = (message: any, convert: ConvertToLlm): any | null => {
  const role = message?.role;
  if (role === "developer" || role === "fileMention") return null;
  if (role === "custom" && message.customType === PIN_NOTICE_TYPE) return null;
  const converted = toLlmSafe(message, convert);
  if (converted.length === 0) return null;
  if (role === "bashExecution" || role === "pythonExecution") return message;
  if (role === "custom") return { ...converted[0], role: "user", injected: true };
  if (role === "branchSummary" || isExtensionUserMessage(message)) return { ...converted[0], injected: true };
  return converted[0];
};

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, as omp's session context builds
// them when it replays the branch.
export const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
  if (entry?.type === "message" && entry.message) return entry.message;
  if (entry?.type === "custom_message") {
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
  if (entry?.type === "branch_summary") {
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
