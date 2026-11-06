// The compaction hook, shared by both hosts. It imports no host package at
// runtime: the host's own functions and rules arrive through a CompactionHost
// (omp: src/hooks/omp-host.ts; Pi: pi.ts), so `bun build --packages external`
// stays on node builtins.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { writeFileSync } from "fs";
import { compileRanked } from "../core/summarize";
import { mergeHistoryIndex, rangeOfWindow, readHistoryIndex, unindexedRange } from "../core/history-index";
import { readPins } from "../core/pins";
import { normalize } from "../core/normalize";
import { buildGlobalIndexById, loadGlobalIndexById } from "../core/global-indices";
import { parseKeepAndPrompt, OMP_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";
import { loadSettings, type VccSettings } from "../core/settings";
import { calibrateCharsPerToken, DEFAULT_CHARS_PER_TOKEN, estimateMessageChars, estimateMessageTokens, estimateTokensFromChars } from "../core/token-estimate";
import { compactionBudgets, OMP_TRIGGER_RULE, type TriggerRule } from "../core/window";
import { applyContextEdits } from "../core/context-edits";
import { modelKey } from "../core/model-limits";
import { triggerFor, windowOf } from "./window-limits";
import { restoreOriginals } from "../core/raw-store";
import { formatWorkingSet, selectWorkingSet, type WorkingSetItem } from "../core/working-set";
import { vccDetailsOf, type VccCompactionDetails } from "../details";
import { COMPACTOR, UNSUMMARIZED_MESSAGE_TYPES } from "../names";
import type { CompactionReason } from "../types";

export { OMP_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptUserTurns: number;
  totalUserTurns: number;
  requestedKeepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  keepFallbackToCompactAll: boolean;
  /** Set when the tail came from a token-budget cut instead of a user-turn cut. */
  budgetCut?: BudgetCutKind;
  keptTokensEst: number;
  /** True when smart-keep boosted the default keep beyond 1. */
  smartKeepAdjusted?: boolean;
  /** Base keep before smart adjustment (for toast like "1→3"). */
  smartFromKeep?: number;
  reason?: CompactionReason;
  willRetry?: boolean;
}

/**
 * no_anchor: no user turn to cut at, so a token-budget cut inside the turn.
 * oversized_tail: the kept user turns were too big, cut inside them.
 * running_turn: a recovery pass on a turn still running, with no earlier user
 *   turn: its newest steps kept, the request and earlier steps summarized.
 * final_reply: a finished turn with no earlier user turn, small enough to keep
 * whole: everything but its final reply is summarized.
 */
export type BudgetCutKind = "no_anchor" | "oversized_tail" | "final_reply" | "running_turn";
export const OVERSIZED_TAIL_FACTOR = 2.5;

/** What started a compaction, and whether the host retries the turn after it. */
export interface CompactionTrigger {
  reason: CompactionReason;
  willRetry: boolean;
}

const MANUAL_TRIGGER: CompactionTrigger = { reason: "manual", willRetry: false };

/** What the compaction hook needs from its host. */
export interface CompactionHost {
  /** The host's own convertToLlm; omp-vcc calls it with one message at a time. */
  convertToLlm: (messages: any[]) => any[];
  /**
   * The trigger of the compaction the hook is running for, given the
   * session_before_compact event: Pi's carries it (`reason`, `willRetry`);
   * omp's carries none (src/hooks/omp-host.ts reads it from
   * auto_compaction_start). Called once per hook run; omitted means manual.
   */
  compactionTrigger?: (event: unknown) => CompactionTrigger;
  /** Where the host compacts, from the policy it hands the hook; omp's when omitted. */
  rule?: TriggerRule;
}

/** Per-registration state. omp binds the factory again for every subagent, so it gets one per binding. */
export interface CompactionState {
  lastStats: CompactionStats | null;
  /** The last compaction came from /omp-vcc, which reports its own outcome. */
  lastCompactFromCommand: boolean;
  pendingFollowUpPrompt: string | null;
  /**
   * The /omp-vcc marker for the manual compaction the command is starting:
   * omp's ctx.compact() cannot carry instructions together with callbacks. The
   * hook reads it for a manual pass that arrives without instructions.
   */
  pendingManualInstructions: string | null;
  /** Why the hook last cancelled a compaction, for /omp-vcc to report where omp shows no notifications. */
  lastCancelNotice: string | null;
  /** The host's trigger as the last threshold pass measured it (its tokensBefore), for this model. */
  measuredTrigger: { key: string; tokens: number } | null;
  /** The host's compaction policy as the last compaction carried it (preparation.settings, read by its TriggerRule), for this model. */
  hostPolicy: { key: string | undefined; policy: object } | null;
  /** The compaction omp-vcc started itself (window-limits.ts), so the hook records why. */
  selfTrigger: CompactionTrigger | null;
  /** The note that omp's window is above the real one was shown. */
  windowNoticeShown: boolean;
}

export const createCompactionState = (): CompactionState => ({
  lastStats: null,
  lastCompactFromCommand: false,
  pendingFollowUpPrompt: null,
  pendingManualInstructions: null,
  lastCancelNotice: null,
  measuredTrigger: null,
  hostPolicy: null,
  selfTrigger: null,
  windowNoticeShown: false,
});

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

export const formatCompactionStats = (stats: CompactionStats): string => {
  if (stats.budgetCut) {
    if (stats.budgetCut === "final_reply") {
      return `omp-vcc: kept the final reply (~${formatTokens(stats.keptTokensEst)} tok), summarized ${stats.summarized}.`;
    }
    if (stats.budgetCut === "running_turn") {
      return `omp-vcc: kept the running turn's latest steps (~${formatTokens(stats.keptTokensEst)} tok), summarized ${stats.summarized}.`;
    }
    const reason = stats.budgetCut === "no_anchor" ? "no user anchor" : "oversized tail";
    return `omp-vcc: kept ~${formatTokens(stats.keptTokensEst)} tok tail (mid-turn cut, ${reason}), summarized ${stats.summarized}.`;
  }
  const notes: string[] = [`summarized ${stats.summarized}`];
  if (stats.smartKeepAdjusted) {
    notes.push("smart-keep");
  }
  return `omp-vcc: kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns, ~${formatTokens(stats.keptTokensEst)} tok (${notes.join(", ")}).`;
};

export const scheduleCompactionStatsNotify = (ctx: any, stats: CompactionStats) => {
  setTimeout(() => {
    try {
      ctx?.ui?.notify?.(
        formatCompactionStats(stats),
        "info",
      );
    } catch {}
  }, 500);
};

const parseCompactionInstructions = (customInstructions?: string): {
  fromCommand: boolean;
  keepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  followUpPrompt: string | null;
} => {
  const trimmed = customInstructions?.trim();
  if (trimmed === OMP_VCC_COMPACT_INSTRUCTION) {
    return { fromCommand: true, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
  }

  const keepPrefix = `${OMP_VCC_COMPACT_INSTRUCTION} `;
  if (trimmed?.startsWith(keepPrefix)) {
    const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
    return {
      fromCommand: true,
      keepUserTurns: parsed.keepUserTurns ?? 1,
      keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
      followUpPrompt: null,
    };
  }

  const parsed = parseKeepAndPrompt(customInstructions);
  return {
    fromCommand: false,
    keepUserTurns: parsed.keepUserTurns ?? 1,
    keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
    followUpPrompt: parsed.followUpPrompt || null,
  };
};

const normalizeKeepUserTurns = (keepUserTurns: number): number => {
  if (!Number.isFinite(keepUserTurns)) return 0;
  return Math.max(0, Math.floor(keepUserTurns));
};

const dbg = (settings: VccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync("/tmp/omp-vcc-debug.json", JSON.stringify(data, null, 2)); } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

/** The host's convertToLlm for one message, as the summarizer input path runs it:
 * a message it rejects or drops yields []. */
const toLlmSafe = (message: unknown, host: CompactionHost): any[] => {
  try {
    return host.convertToLlm([message as any]);
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
export const toSummaryMessage = (message: any, host: CompactionHost): any | null => {
  const role = message?.role;
  if (role === "developer" || role === "fileMention") return null;
  if (role === "custom" && UNSUMMARIZED_MESSAGE_TYPES.has(message.customType)) return null;
  const converted = toLlmSafe(message, host);
  if (converted.length === 0) return null;
  if (role === "bashExecution" || role === "pythonExecution") return message;
  if (role === "custom") return { ...converted[0], role: "user", injected: true };
  if (role === "user" && message.attribution === "agent") return { ...converted[0], injected: true };
  return converted[0];
};

/** A custom_message the user listed in skipCustomTypes; dropped before summarizing. */
const isSkippedCustom = (m: any, skipCustomTypes: readonly string[]): boolean =>
  m?.role === "custom" && skipCustomTypes.includes(m?.customType);

/** True when the prefix would contribute at least one block to the summary.
 * Runs the same path as the summarizer (skipCustomTypes filter, toSummaryMessage,
 * normalize): custom_message and branch_summary become user content and render,
 * while role "system" passes through unchanged and renders nothing. */
const prefixHasRenderableContent = (
  prefix: EntryWithMessage[],
  skipCustomTypes: readonly string[],
  host: CompactionHost,
): boolean =>
  normalize(
    prefix
      .filter((m) => !isSkippedCustom(m.message, skipCustomTypes))
      .map((m) => toSummaryMessage(m.message, host))
      .filter((m) => m != null),
  ).length > 0;

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, as omp's session context builds
// them when it replays the branch.
const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
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

/** Chars of what stays in context from these entries: every live message, whatever its shape (custom messages and branch summaries included). */
const keptChars = (entries: any[]): number =>
  entries.reduce((sum: number, e: any) => {
    const m = e?.type === "compaction" ? null : toLiveMessage(e);
    return m ? sum + estimateMessageChars(m) : sum;
  }, 0);

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | {
      ok: true;
      messages: any[];
      /** Entry ids parallel to `messages` — used to resolve global `#N` refs. */
      selectedIds: string[];
      firstKeptEntryId: string;
      compactAll: boolean;
      keptUserTurns: number;
      totalUserTurns: number;
      requestedKeepUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: OwnCutCancelReason };

const lastIndexOfType = (entries: any[], type: string): number => {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.type === type) return i;
  return -1;
};

/**
 * Index of the first branch entry still in the model's context: everything from
 * here on (minus compaction entries) is live.
 *
 * - No compaction: the whole branch.
 * - After a compaction: its firstKeptEntryId. Orphan recovery: when that id is ""
 *   (sentinel from a prior compact-all) or no longer in the branch, right after
 *   the compaction entry; or, for an omp native-replay compaction, right after
 *   its providerReplayThroughEntryId, which is where omp's own kept tail starts.
 * - omp's `/clear` writes a reset_boundary: one after the latest compaction
 *   starts the window after it, and one before it bounds where the kept id is
 *   looked for. This mirrors omp's prepareCompaction, which also drops the
 *   previous summary in the first case.
 */
const liveWindowStart = (branchEntries: any[]): number => {
  const resetIdx = lastIndexOfType(branchEntries, "reset_boundary");
  const compactionIdx = lastIndexOfType(branchEntries, "compaction");
  if (resetIdx > compactionIdx) return resetIdx + 1;
  if (compactionIdx < 0) return 0;

  const compaction = branchEntries[compactionIdx];
  const findAfterReset = (id: unknown) =>
    typeof id === "string" && id
      ? branchEntries.findIndex((e: any, i: number) => i > resetIdx && e.id === id)
      : -1;
  const keptIdx = findAfterReset(compaction.firstKeptEntryId);
  if (keptIdx >= 0) return keptIdx;
  const replayIdx = findAfterReset(compaction.providerReplayThroughEntryId);
  if (replayIdx >= 0 && replayIdx < compactionIdx) return replayIdx + 1;
  return compactionIdx + 1;
};

const collectLiveMessages = (branchEntries: any[]): EntryWithMessage[] => {
  const liveMessages: EntryWithMessage[] = [];
  for (let i = liveWindowStart(branchEntries); i < branchEntries.length; i++) {
    const e = branchEntries[i];
    if (e.type === "compaction") continue;
    const m = toLiveMessage(e);
    if (m) liveMessages.push({ entry: e, message: m });
  }
  return liveMessages;
};

export function buildOwnCut(
  host: CompactionHost,
  branchEntries: any[],
  keepUserTurns = 1,
  skipCustomTypes: readonly string[] = [],
): OwnCutResult {
  const normalizedKeepUserTurns = normalizeKeepUserTurns(keepUserTurns);
  const liveMessages = collectLiveMessages(branchEntries);

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };
  // A window with nothing renderable compiles to "" whichever cut is chosen, so
  // the hook would store an empty summary while keeping everything. Treat it as
  // nothing to compact — include it in compactAll, declare it empty.
  if (!prefixHasRenderableContent(liveMessages, skipCustomTypes, host)) return { ok: false, reason: "no_live_messages" };

  const userIndices = liveMessages.reduce<number[]>((acc, e, i) => {
    if (e.message.role === "user") acc.push(i);
    return acc;
  }, []);
  const compactAll = (keepFallbackToCompactAll: boolean) => ({
    ok: true as const,
    messages: liveMessages.map((e) => e.message),
    selectedIds: liveMessages.map((e) => e.entry.id),
    firstKeptEntryId: "",
    compactAll: true,
    keptUserTurns: 0,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll,
  });

  if (normalizedKeepUserTurns <= 0) return compactAll(false);

  // Summarize all messages before the requested kept user-turn tail.
  const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;

  if (cutIdx <= 0) {
    // Keep request cannot form a safe boundary (single user prompt, no user prompt,
    // or keep larger than available user turns), so compact EVERYTHING and keep no tail.
    // firstKeptEntryId="" is a sentinel: omp's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return compactAll(true);
  }

  // A prefix that renders no block would compile to "", storing an empty summary
  // while keeping every message: context never shrinks and the next agent_end
  // re-triggers compaction indefinitely. A role:"system" entry renders nothing
  // (omp's convertToLlm drops it), so when it alone precedes the first user
  // message the prefix is empty; a custom_message listed in skipCustomTypes does
  // the same. Fall back
  // to compact-all, the same path already used when no safe boundary exists;
  // applyTailBudget then decides the tail.
  if (!prefixHasRenderableContent(liveMessages.slice(0, cutIdx), skipCustomTypes, host)) return compactAll(true);

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    selectedIds: liveMessages.slice(0, cutIdx).map((e) => e.entry.id),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
    keptUserTurns: userIndices.length - targetUserIdx,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll: false,
  };
}

// Token-budget tail cut: rescue default-path sessions when the user-turn
// anchored tail is absent (autonomous: no user boundary in the live window)
// or oversized (a single giant last user turn). Cuts at the nearest valid
// non-toolResult boundary, like omp's own cut point.
export const findBudgetCutIndex = (
  live: EntryWithMessage[],
  maxTokens: number,
  charsPerToken?: number,
): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(live[i].message, charsPerToken);
    if (acc >= maxTokens) {
      crossed = i;
      break;
    }
  }
  if (crossed < 0) return -1;
  // Snap forward off any toolResult to the next valid boundary.
  for (let j = Math.max(crossed, 1); j < live.length; j++) {
    if (live[j].message.role !== "toolResult") return j;
  }
  return -1;
};

/** The cut at live index `idx`: everything before it summarized, the rest kept. */
const cutAt = (live: EntryWithMessage[], idx: number, cut: Extract<OwnCutResult, { ok: true }>, budgetCut: BudgetCutKind): OwnCutResult => ({
  ok: true,
  messages: live.slice(0, idx).map((m) => m.message),
  selectedIds: live.slice(0, idx).map((m) => m.entry.id),
  firstKeptEntryId: live[idx].entry.id,
  compactAll: false,
  keptUserTurns: live.slice(idx).filter((m) => m.message.role === "user").length,
  totalUserTurns: live.filter((m) => m.message.role === "user").length,
  requestedKeepUserTurns: cut.requestedKeepUserTurns,
  keepFallbackToCompactAll: false,
  budgetCut,
});

/**
 * A recovery pass (an overflow, a cut-off reply) on a turn still running whose
 * live window has no earlier user turn: something must shrink, and summarizing
 * the whole turn takes away the tool output the agent is working from. Keep the
 * turn's newest steps, at most half of the window and the tail budget, and
 * summarize the request and the steps before them (their originals stay in
 * recall). Undefined when no boundary leaves that: then the whole window is
 * summarized. What is kept and still too big, omp's own rescue trims after the
 * compaction commits (it shakes oversized tool output).
 */
export const runningTurnCut = (
  host: CompactionHost,
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens?: number; charsPerToken?: number; skipCustomTypes?: readonly string[] } = {},
): OwnCutResult | undefined => {
  if (!cut.ok) return undefined;
  const live = collectLiveMessages(branchEntries);
  const tokens = live.map((m) => estimateMessageTokens(m.message, opts.charsPerToken));
  const target = Math.min(opts.maxTokens ?? MAX_SMART_TAIL_TOKENS, tokens.reduce((a, b) => a + b, 0) / 2);
  let tail = 0;
  let best = -1;
  for (let i = live.length - 1; i >= 1; i--) {
    tail += tokens[i];
    if (tail > target) break;
    if (live[i].message.role !== "toolResult") best = i;
  }
  if (best < 1 || !prefixHasRenderableContent(live.slice(0, best), opts.skipCustomTypes ?? [], host)) return undefined;
  return cutAt(live, best, cut, "running_turn");
};

/**
 * One or two live messages, summarized whole: on a recovery pass something must
 * shrink, and a request or reply far too big for the window (a long paste, one
 * huge result) shrinks to its summary line, its original in recall.
 */
export const wholeWindowCut = (host: CompactionHost, branchEntries: any[], skipCustomTypes: readonly string[] = []): OwnCutResult | undefined => {
  const live = collectLiveMessages(branchEntries);
  if (live.length === 0 || !prefixHasRenderableContent(live, skipCustomTypes, host)) return undefined;
  return {
    ok: true,
    messages: live.map((e) => e.message),
    selectedIds: live.map((e) => e.entry.id),
    firstKeptEntryId: "",
    compactAll: true,
    keptUserTurns: 0,
    totalUserTurns: live.filter((e) => e.message.role === "user").length,
    requestedKeepUserTurns: 0,
    keepFallbackToCompactAll: false,
  };
};

/** An assistant message that ends a turn: text, and no tool call still waiting for its result. */
const isFinalAnswer = (message: { role: string; content: unknown }): boolean =>
  message.role === "assistant" &&
  Array.isArray(message.content) &&
  message.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") &&
  !message.content.some((part: any) => part?.type === "toolCall");

export const applyTailBudget = (
  host: CompactionHost,
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens?: number; oversizedFactor?: number; charsPerToken?: number; skipCustomTypes?: readonly string[] } = {},
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const live = collectLiveMessages(branchEntries);
  // Same guard as buildOwnCut, for the compact-all re-cut: a budget cut right
  // after a lone system entry (first user message alone over budget) would
  // summarize nothing. Case B never needs it: its cut extends a prefix that
  // already renders.
  const renders = (idx: number) => prefixHasRenderableContent(live.slice(0, idx), opts.skipCustomTypes ?? [], host);

  const budgetResult = (idx: number, budgetCut: BudgetCutKind): OwnCutResult => ({
    ok: true,
    messages: live.slice(0, idx).map((m) => m.message),
    selectedIds: live.slice(0, idx).map((m) => m.entry.id),
    firstKeptEntryId: live[idx].entry.id,
    compactAll: false,
    keptUserTurns: live.slice(idx).filter((m) => m.message.role === "user").length,
    totalUserTurns: live.filter((m) => m.message.role === "user").length,
    requestedKeepUserTurns: cut.requestedKeepUserTurns,
    keepFallbackToCompactAll: false,
    budgetCut,
  });

  // Case A: no user anchor → compact-all. Re-cut to a token budget unless the
  // compact-all came from explicit keep:0 (which must be respected absolutely).
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    // A cut that keeps only the turn's final answer kept a finished turn's reply, not part of a running one.
    if (idx >= 0) {
      if (!renders(idx)) return cut;
      return budgetResult(idx, idx === live.length - 1 && isFinalAnswer(live[idx].message) ? "final_reply" : "no_anchor");
    }
    // The whole window fits the budget. When it ends with the turn's final
    // answer, keep that answer and summarize the rest: compact-all would take the
    // reply out of context too, and omp's print mode, which prints the last
    // assistant message, would then have nothing.
    const last = live.length - 1;
    if (last > 0 && isFinalAnswer(live[last].message) && renders(last)) return budgetResult(last, "final_reply");
    return cut;
  }

  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
  // maxTokens * factor (tolerance zone below is unchanged).
  const tailStart = cut.messages.length; // equals the cut index in the live window
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) {
    tailTokens += estimateMessageTokens(live[i].message, opts.charsPerToken);
  }
  if (tailTokens <= maxTokens * factor) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
  if (idx <= tailStart) return cut;
  return budgetResult(idx, "oversized_tail");
};

// ── smart keep-tail: boost default keep when tail is small ──

export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;

export interface ResolveSmartKeepOptions {
  branchEntries: any[];
  /** Requested keep:N; null when user did not specify (default path). */
  requestedKeepUserTurns: number | null;
  /** True when user typed keep:N explicitly — always respected. */
  explicit: boolean;
  /** Setting toggle. */
  smartKeepTail: boolean;
  /** Injectable thresholds for tests. */
  minTokens?: number;
  maxTokens?: number;
  /** Calibrated chars/token for the current session; defaults to heuristic when omitted. */
  charsPerToken?: number;
  host: CompactionHost;
}

export interface ResolveSmartKeepResult {
  keepUserTurns: number;
  smartAdjusted: boolean;
  /** Original base keep, for toast like "1→3". */
  fromKeep: number;
}

/**
 * Estimate tail tokens for a given keep:N.
 * Returns null when keep would trigger compact-all (tail lost) or cancel,
 * so the resolver can stop growing instead of selecting a value that
 * discards the tail entirely.
 */
const tailTokensForKeep = (
  branchEntries: any[],
  keepUserTurns: number,
  charsPerToken: number | undefined,
  host: CompactionHost,
): number | null => {
  const cut = buildOwnCut(host, branchEntries, keepUserTurns, []);
  if (!cut.ok || cut.compactAll) return null;
  const idx = branchEntries.findIndex((e: any) => e.id === cut.firstKeptEntryId);
  if (idx < 0) return null;
  return estimateTokensFromChars(keptChars(branchEntries.slice(idx)), charsPerToken);
};

/**
 * Resolve the effective keep:N.
 * - Explicit keep:N from the user is always respected.
 * - smartKeepTail=false → old behavior (default keep:1).
 * - smartKeepTail=true → if keep:1 tail <= minTokens, grow keep to the
 *   largest N whose tail stays <= maxTokens. Stops at compact-all boundary.
 */
export const resolveSmartKeepUserTurns = (opts: ResolveSmartKeepOptions): ResolveSmartKeepResult => {
  const minTokens = opts.minTokens ?? MIN_SMART_TAIL_TOKENS;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const baseKeep = opts.requestedKeepUserTurns ?? 1;

  if (opts.explicit || !opts.smartKeepTail) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseTokens = tailTokensForKeep(opts.branchEntries, baseKeep, opts.charsPerToken, opts.host);
  // base tail already above min (or unmeasurable / compact-all) → don't grow.
  if (baseTokens == null || baseTokens > minTokens) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseCut = buildOwnCut(opts.host, opts.branchEntries, baseKeep, []);
  const totalUserTurns = baseCut.ok ? baseCut.totalUserTurns : 0;

  let selected = baseKeep;
  for (let k = baseKeep + 1; k <= totalUserTurns; k++) {
    const tokens = tailTokensForKeep(opts.branchEntries, k, opts.charsPerToken, opts.host);
    if (tokens == null || tokens > maxTokens) break;
    selected = k;
  }

  return {
    keepUserTurns: selected,
    smartAdjusted: selected !== baseKeep,
    fromKeep: baseKeep,
  };
};

/**
 * Prompt tokens of the session's first request less what its messages account
 * for: the system prompt and tool schemas every request carries. Undefined when
 * no request recorded its usage.
 */
const measuredOverheadTokens = (branchEntries: any[]): number | undefined => {
  let chars = 0;
  for (const e of branchEntries) {
    if (e?.type !== "message" || !e.message) continue;
    const m = e.message;
    const u = m.role === "assistant" ? m.usage : undefined;
    const prompt = u ? (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) : 0;
    if (prompt > 0) return Math.max(0, prompt - estimateTokensFromChars(chars, DEFAULT_CHARS_PER_TOKEN));
    chars += estimateMessageChars(m);
  }
  return undefined;
};

/** [Working Set] brings back at most this share of what a compaction removes. */
const WORKING_SET_SHARE_OF_REMOVED = 0.5;

/** Growth a summary may add before it is not worth writing: its framing (the
 * budgets' growthMarginChars, 500 up to a very large window), or a share of what it replaces. */
const GROWTH_MARGIN_CHARS = 500;
const GROWTH_MARGIN_SHARE = 0.25;

export interface SummaryGrowth {
  /** What the new summary adds beyond the previous one it replaces, less the messages it summarizes. */
  netChars: number;
  allowedChars: number;
  grows: boolean;
}

/**
 * Whether writing this summary would make the context bigger. The new summary
 * replaces the previous one and the summarized messages; the kept tail is the
 * same either way. A short prefix (two messages after omp's plan-mode "approve
 * and compact", a session barely past a low threshold) can be smaller than the
 * sections and brief that would replace it.
 */
export const summaryGrowth = (
  summaryChars: number,
  previousSummaryChars: number,
  prefixChars: number,
  marginChars = GROWTH_MARGIN_CHARS,
): SummaryGrowth => {
  const netChars = summaryChars - previousSummaryChars - prefixChars;
  const allowedChars = Math.max(marginChars, Math.round(prefixChars * GROWTH_MARGIN_SHARE));
  return { netChars, allowedChars, grows: netChars > allowedChars };
};

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "omp-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "omp-vcc: Too few messages to compact",
};

/**
 * Register the compaction hook on `pi`. omp binds the factory once per session
 * (subagents too), so each binding passes its own `state`.
 */
export const registerCompactionHook = (
  pi: ExtensionAPI,
  host: CompactionHost,
  state: CompactionState,
) => {
  pi.on("session_before_compact", (event, ctx) => {
    const { preparation } = event;
    // What the context holds: Pi's context edits applied, as Pi applies them
    // (core/context-edits.ts). An omp branch has none and comes back as it is.
    const branchEntries = applyContextEdits(event.branchEntries as any[]);
    const rule = host.rule ?? OMP_TRIGGER_RULE;
    const hostTrigger = host.compactionTrigger?.(event);
    const { reason, willRetry } = state.selfTrigger ?? hostTrigger ?? MANUAL_TRIGGER;
    const customInstructions = event.customInstructions
      ?? (reason === "manual" ? state.pendingManualInstructions ?? undefined : undefined);
    const settings = loadSettings();

    // Always handle the /omp-vcc marker.
    // Otherwise, only handle when user opted in via settings.
    const { fromCommand, keepUserTurns, keepUserTurnsExplicit, followUpPrompt } = parseCompactionInstructions(customInstructions);
    state.pendingFollowUpPrompt = null;
    if (!fromCommand && !settings.overrideDefaultCompaction) return;
    // Provider-level opt-out (#27): defer to the provider's own compaction
    // (e.g. a provider's remote compaction). Checked at call time because the
    // model can change mid-session via /model. Explicit /omp-vcc bypasses the
    // skip; undefined model never skips.
    const provider = ctx?.model?.provider;
    if (!fromCommand && typeof provider === "string" &&
        settings.skipForProviders.some((p) => p.toLowerCase() === provider.toLowerCase())) return;

    const calibrationCut = buildOwnCut(host, branchEntries as any[], 0, []);
    const calibrationMessageChars = calibrationCut.ok
      ? calibrationCut.messages.reduce(
          (sum: number, message: any) => sum + estimateMessageChars(message),
          0,
        )
      : 0;
    const calibrationSummaryChars = typeof preparation.previousSummary === "string"
      ? preparation.previousSummary.length
      : 0;
    // The overhead is what a compaction cannot remove (system prompt, tool
    // schemas). The session's first request measured it: its prompt held little
    // else. Without one, the provider-counted context less what the messages
    // account for at 4 chars/token, which overstates it for dense text.
    const measuredOverhead = measuredOverheadTokens(branchEntries as any[]);
    const contentChars = calibrationMessageChars + calibrationSummaryChars;
    const contentTokens = measuredOverhead !== undefined && preparation.tokensBefore > measuredOverhead
      ? preparation.tokensBefore - measuredOverhead
      : preparation.tokensBefore;
    // Calibrated on the messages alone where the overhead is known, so a summary's
    // token budget maps to the chars the messages actually take.
    const tokenEstimate = calibrateCharsPerToken(contentChars, contentTokens);
    const overheadTokens = measuredOverhead
      ?? (preparation.tokensBefore > 0 ? Math.max(0, preparation.tokensBefore - estimateTokensFromChars(contentChars, DEFAULT_CHARS_PER_TOKEN)) : 0);

    // Budgets from the model's real window and where the next compaction comes (core/window.ts).
    const window = windowOf(ctx?.model, rule.host);
    const trigger = triggerFor(window, state, modelKey(ctx?.model), reason, preparation.tokensBefore, rule.policyOf((preparation as { settings?: unknown }).settings), rule);
    const budgets = compactionBudgets(trigger, overheadTokens, settings.workingSet);

    // Smart keep-tail: boost default keep when the tail is small.
    // Explicit keep:N from the user is always respected (resolver no-ops).
    const smartKeep = resolveSmartKeepUserTurns({
      branchEntries: branchEntries as any[],
      requestedKeepUserTurns: keepUserTurnsExplicit ? keepUserTurns : null,
      explicit: keepUserTurnsExplicit,
      smartKeepTail: settings.smartKeepTail,
      charsPerToken: tokenEstimate.charsPerToken,
      minTokens: budgets.minTailTokens,
      maxTokens: budgets.maxTailTokens,
      host,
    });
    let ownCut = buildOwnCut(host, branchEntries as any[], smartKeep.keepUserTurns, settings.skipCustomTypes);
    // Default path only: rescue autonomous / oversized-tail sessions with a
    // token-budget cut. Explicit keep:N is respected absolutely (no-op here).
    if (ownCut.ok && !keepUserTurnsExplicit) {
      ownCut = applyTailBudget(host, branchEntries as any[], ownCut, {
        charsPerToken: tokenEstimate.charsPerToken,
        skipCustomTypes: settings.skipCustomTypes,
        maxTokens: budgets.maxTailTokens,
      });
    }
    // A recovery pass (an overflow, a cut-off reply) must shrink the context.
    // omp-vcc answers it itself: stepping aside hands it to the method omp picked
    // (snapcompact, handoff, server compaction, an LLM summary). What is kept and
    // still too big, omp's rescue shakes after the compaction commits.
    const recovering = !fromCommand && (reason === "overflow" || reason === "incomplete" || willRetry);
    // An automatic pass on a turn still running (its last message is a tool result:
    // omp compacts between the tool calls of one turn) whose live window has no
    // earlier user turn and fits the tail budget: the only cut left is compact-all,
    // which would summarize away the request and tool output the agent is working
    // from. A threshold or idle pass waits until the turn has ended; a recovery
    // pass keeps the turn's newest steps and summarizes the rest.
    if (
      ownCut.ok && ownCut.compactAll && ownCut.keepFallbackToCompactAll && !fromCommand
      && ownCut.messages[ownCut.messages.length - 1]?.role === "toolResult"
      && (reason === "threshold" || reason === "idle" || reason === "overflow" || reason === "incomplete")
    ) {
      if (!recovering) {
        state.pendingFollowUpPrompt = null;
        dbg(settings, { deferredRunningTurn: true, compaction: { reason, willRetry }, liveMessages: ownCut.messages.length });
        return { cancel: true };
      }
      ownCut = runningTurnCut(host, branchEntries as any[], ownCut, {
        charsPerToken: tokenEstimate.charsPerToken,
        skipCustomTypes: settings.skipCustomTypes,
        maxTokens: budgets.maxTailTokens,
      }) ?? ownCut;
      dbg(settings, { runningTurnRecovery: true, compaction: { reason, willRetry }, budgetCut: ownCut.ok ? ownCut.budgetCut : undefined });
    }
    // One or two messages too big for the window: summarized whole on a recovery pass.
    if (!ownCut.ok && recovering && ownCut.reason === "too_few_live_messages") {
      ownCut = wholeWindowCut(host, branchEntries as any[], settings.skipCustomTypes) ?? ownCut;
    }
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e) => e.type === "compaction");
      const lastCompIdx = lastComp ? (branchEntries as any[]).indexOf(lastComp) : -1;

      // The live window buildOwnCut used, as message roles, for the diagnostic.
      const liveRoles: string[] = (branchEntries as any[])
        .slice(liveWindowStart(branchEntries as any[]))
        .filter((e: any) => e.type === "message" && e.message)
        .map((e: any) => e.message.role);
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      state.pendingFollowUpPrompt = null;
      // Nothing live to summarize: no method of omp's can shrink it either.
      const fallbackToCore = recovering;
      dbg(settings, {
        cancelled: !fallbackToCore,
        fallbackToCore,
        reason: ownCut.reason,
        compaction: { reason, willRetry },
        fromCommand,
        counts: {
          total: branchEntries.length,
          messages: (branchEntries as any[]).filter((e: any) => e.type === "message").length,
          compactions: (branchEntries as any[]).filter((e: any) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30
            ? liveRoles
            : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!lastComp.firstKeptEntryId,
          foundInBranch: lastComp.firstKeptEntryId
            ? (branchEntries as any[]).some((e: any) => e.id === lastComp.firstKeptEntryId)
            : null,
        } : null,
        tail: (branchEntries as any[]).slice(-5).map((e: any) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
      });

      if (fallbackToCore) return;

      state.lastCancelNotice = REASON_MESSAGES[ownCut.reason];
      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    state.pendingFollowUpPrompt = followUpPrompt;
    // Filter user-declared customTypes right before summarizer input
    // (skipCustomTypes). Cut selection, token calibration, firstKeptEntryId
    // and kept-user-turn counting are already fixed upstream — this only
    // changes what the summarizer sees. The pair must stay aligned.
    let agentMessages = ownCut.messages;
    let agentSelectedIds = ownCut.selectedIds;
    if (settings.skipCustomTypes.length > 0) {
      const pairs = agentMessages
        .map((m: any, i: number) => ({ m, id: agentSelectedIds[i] }))
        .filter(({ m }: any) => !isSkippedCustom(m, settings.skipCustomTypes));
      agentMessages = pairs.map((p: any) => p.m);
      agentSelectedIds = pairs.map((p: any) => p.id);
    }
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    // omp may have blanked or shaken some of these in place since they landed.
    // The summary is all that will remain of them, so it is written from the
    // originals omp-vcc kept (core/raw-store.ts); the cut and the budgets above
    // count what the context holds now.
    agentMessages = restoreOriginals(agentMessages, agentSelectedIds, (ctx as any)?.sessionManager?.getSessionFile?.());

    // ── Session-global indices for summary refs (issue #28) ──────────
    // Recall numbers messages across the whole session file (all windows,
    // all branches); the selected window is zero-based. Map each selected
    // entry id to its global index so emitted (#N) refs resolve via recall.
    // Primary source is the in-memory tree (file order, synchronously
    // persisted); the session file is the streaming fallback.
    let globalIndexById: Map<string, number> | undefined;
    try {
      const all = (ctx as any)?.sessionManager?.getEntries?.();
      if (Array.isArray(all)) globalIndexById = buildGlobalIndexById(all);
    } catch {
      globalIndexById = undefined;
    }
    if (!globalIndexById) {
      try {
        const sf = (ctx as any)?.sessionManager?.getSessionFile?.();
        if (typeof sf === "string" && sf) globalIndexById = loadGlobalIndexById(sf);
      } catch {
        globalIndexById = undefined;
      }
    }

    // convertToLlm is elementwise (drops/replaces per message, order
    // preserved), so align ids by converting singletons — never by position.
    // toSummaryMessage says what each message becomes (see there).
    const convertedWithIndices: Array<{ message: any; sourceIndex: number | undefined }> = [];
    for (let i = 0; i < agentMessages.length; i++) {
      const message = toSummaryMessage(agentMessages[i], host);
      if (message == null) continue;
      convertedWithIndices.push({ message, sourceIndex: globalIndexById?.get(agentSelectedIds[i]) });
    }
    const messages = convertedWithIndices.map((x) => x.message);
    // Fail-closed: when no index map exists at all every slot is undefined,
    // so refs are omitted rather than emitted window-relative (the bug being
    // fixed). Parallel to `messages` by construction.
    const sourceIndices = convertedWithIndices.map((x) => x.sourceIndex);

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptTailChars = keptIdx >= 0 ? keptChars((branchEntries as any[]).slice(keptIdx)) : 0;
    state.lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      requestedKeepUserTurns: ownCut.requestedKeepUserTurns,
      keepUserTurnsExplicit,
      keepFallbackToCompactAll: ownCut.keepFallbackToCompactAll,
      keptTokensEst: estimateTokensFromChars(keptTailChars, tokenEstimate.charsPerToken),
      smartKeepAdjusted: smartKeep.smartAdjusted,
      smartFromKeep: smartKeep.fromKeep,
      budgetCut: ownCut.ok ? ownCut.budgetCut : undefined,
      reason,
      willRetry,
    };

    const config = settings;

    // Ranked compaction: keep the highest-signal blocks under a token budget
    // instead of the old unranked compile() (fixed 120-line cap). The token
    // budget is converted to a char budget via the session's calibrated
    // charsPerToken so the summary targets ~RANKED_BRIEF_BUDGET_TOKENS tokens
    // regardless of content density.
    //
    // The budget is SIZE-RELATIVE: it scales with transcript length between a
    // floor (RANKED_BRIEF_BUDGET_TOKENS) and a ceiling (RANKED_BRIEF_CEILING_TOKENS)
    // at RANKED_BRIEF_CHARS_PER_BLOCK per normalized block. Small/medium sessions
    // stay at the floor (size parity with the old cap); very large transcripts --
    // which carry far more high-value long-tail (edits, commands, tests) than the
    // old 120-line brief could hold -- earn more budget up to the ceiling, while
    // the ceiling keeps growth bounded (no return of the ~60% bloat).
    // Audit (research/audit, 794 sessions, vs shipped master 0.3.18): SMALL/MED
    // unchanged; LARGE bucket paired recall -5.0pp -> -2.3pp (median to parity),
    // long-tail losers 100/369 -> 67/369; fact density stays ~1.4x master.
    // Floor and ceiling follow the trigger (core/window.ts): 1100 and 2000 on a
    // ~128K window, less on a small one, a higher ceiling on a very large one.
    const RANKED_BRIEF_BUDGET_TOKENS = budgets.briefTokens;
    const RANKED_BRIEF_CEILING_TOKENS = budgets.briefCeilingTokens;
    const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;
    // [History Index]: this window's range added to the one the previous omp-vcc
    // compaction stored. Only a compaction still in context counts: after omp's
    // /clear (a later reset_boundary) the index starts over, as the summary does.
    const lastCompactionIdx = lastIndexOfType(branchEntries as any[], "compaction");
    const previousCompaction = lastCompactionIdx > lastIndexOfType(branchEntries as any[], "reset_boundary")
      ? (branchEntries as any[])[lastCompactionIdx]
      : undefined;
    const windowRange = rangeOfWindow(messages, sourceIndices);
    const storedIndex = previousCompaction ? readHistoryIndex(previousCompaction.details) : [];
    const historyIndex = windowRange
      ? mergeHistoryIndex(
          storedIndex ?? (windowRange.from > 0 ? [unindexedRange(windowRange.from - 1)] : []),
          windowRange,
          budgets.summary.historyRanges,
        )
      : undefined;

    const pinnedNotes = readPins(branchEntries as any[]);

    // [Working Set]: what the next step likely needs, brought back from the
    // originals with the compaction (core/working-set.ts), so the agent does not
    // spend its next requests fetching it again.
    let workingSet: { items: WorkingSetItem[]; lines: string[] } | undefined;
    if (settings.workingSet && budgets.workingSetTokens > 0) {
      const all = branchEntries as any[];
      const keptAt = firstKeptEntryId ? all.findIndex((e: any) => e.id === firstKeptEntryId) : -1;
      const kept = keptAt >= 0 ? all.slice(keptAt).map(toLiveMessage).filter(Boolean) : [];
      // Everything out of context once this lands, since /clear: what this
      // compaction summarizes and what earlier ones did, from the originals.
      const past = all
        .slice(lastIndexOfType(all, "reset_boundary") + 1, keptAt >= 0 ? keptAt : all.length)
        .filter((e: any) => e?.type !== "compaction")
        .map((e: any) => ({ id: e.id as string, m: toLiveMessage(e) }))
        .filter((x: any) => x.m);
      const pastIds = past.map((x: any) => x.id);
      const history = restoreOriginals(past.map((x: any) => x.m), pastIds, (ctx as any)?.sessionManager?.getSessionFile?.());
      // Never more than half of what this compaction removes, so it always frees room.
      const removedChars = ownCut.messages.reduce((sum: number, m: any) => sum + estimateMessageChars(m), 0);
      const maxChars = Math.round(Math.min(budgets.workingSetTokens * tokenEstimate.charsPerToken, removedChars * WORKING_SET_SHARE_OF_REMOVED));
      const items = selectWorkingSet({
        history,
        indices: pastIds.map((id: string) => globalIndexById?.get(id)),
        kept,
        maxChars,
      });
      const lines = formatWorkingSet(items, maxChars);
      if (lines.length > 0) workingSet = { items, lines };
    }

    const summary = compileRanked({
      messages,
      sourceIndices,
      historyIndex,
      pinnedNotes,
      workingSet: workingSet?.lines,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.edited],
        writtenFiles: [...preparation.fileOps.written],
      },
      trackCommands: settings.trackCommands,
      limits: budgets.summary,
      ranking: {
        maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * tokenEstimate.charsPerToken),
        maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * tokenEstimate.charsPerToken),
        briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * tokenEstimate.charsPerToken),
      },
    });

    // Growth guard: a compaction that leaves the context bigger is not written,
    // and a manual pass says why (an automatic one would say so on every turn
    // until the prefix grows). Recovering, it is written when it keeps part of
    // the window: what overflows is that kept part, and omp's rescue shakes its
    // oversized tool output once this commits. When even summarizing the whole
    // window grows the context, what fills it is what no compaction removes.
    const growth = summaryGrowth(
      summary.length,
      typeof preparation.previousSummary === "string" ? preparation.previousSummary.length : 0,
      ownCut.messages.reduce((sum: number, m: any) => sum + estimateMessageChars(m), 0),
      budgets.growthMarginChars,
    );
    if (growth.grows && recovering && !ownCut.compactAll) {
      dbg(settings, { growthGuard: growth, writtenForRescue: true, compaction: { reason, willRetry }, summarized: ownCut.messages.length });
    } else if (growth.grows) {
      state.pendingFollowUpPrompt = null;
      state.lastStats = null;
      dbg(settings, { growthGuard: growth, compaction: { reason, willRetry }, summarized: ownCut.messages.length });
      if (recovering) {
        const notice = `omp-vcc: Not compacted: the ${ownCut.messages.length} messages left are smaller than a summary of them; the context is full of what no compaction removes (the system prompt and tools).`;
        state.lastCancelNotice = notice;
        try {
          ctx?.ui?.notify?.(notice, "warning");
        } catch {}
        return { cancel: true };
      }
      if (reason === "manual") {
        const more = ownCut.compactAll ? "" : " keep:0 summarizes everything.";
        const notice = `omp-vcc: Not compacted: the summary would be ${growth.netChars} chars larger than the ${ownCut.messages.length} messages it replaces.${more}`;
        state.lastCancelNotice = notice;
        try {
          ctx?.ui?.notify?.(notice, "warning");
        } catch {}
      }
      return { cancel: true };
    }

    const branchIds = branchEntries.map((e: any) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutIdx >= 0
      ? branchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e: any) => ({
          id: e.id,
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
        }))
      : [];

    dbg(config, {
      usedOwnCut: true,
      budgetCut: ownCut.budgetCut,
      compaction: { reason, willRetry },
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages.slice(0, 3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      messagesPreviewTail: agentMessages.slice(-3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      convertedMessages: messages.length,
      firstKeptEntryId,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      tokenEstimate,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
    });

    const details: VccCompactionDetails = {
      compactor: COMPACTOR,
      // version 2 = refs are session-global (recall index space); version 1
      // summaries carried window-relative refs (issue #28).
      version: 2,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      reason,
      willRetry,
      ...(historyIndex ? { historyIndex } : {}),
      // The #N of what [Working Set] brought back.
      ...(workingSet ? { workingSet: workingSet.items.filter((i) => workingSet!.lines.some((l) => l.startsWith(`- #${i.index} `))).map((i) => i.index) } : {}),
      // What the budgets were sized from, for debugging a compaction that kept too much or too little.
      limits: {
        ...(window.effective ? { contextWindow: window.effective, windowSource: window.source } : {}),
        ...(trigger ? { trigger } : {}),
        ...(overheadTokens ? { overheadTokens } : {}),
        maxTailTokens: budgets.maxTailTokens,
        briefCeilingTokens: budgets.briefCeilingTokens,
        ...(budgets.summaryScale !== 1 ? { summaryScale: budgets.summaryScale } : {}),
        workingSetTokens: budgets.workingSetTokens,
      },
    };

    state.lastCompactFromCommand = fromCommand;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  // Fire success toast for /compact and automatic compactions (delayed to let the
  // UI settle). /omp-vcc reports through its own onComplete callback.
  pi.on("session_compact", async (event, ctx) => {
    if (!event.fromExtension) return;
    // Another compaction extension can win even when omp-vcc also returned a
    // result, so read the persisted entry rather than lifecycle state: omp-vcc
    // stamps its compactor, reason and willRetry on its own details.
    const details = vccDetailsOf(event.compactionEntry?.details);
    if (!details) return;
    const followUpPrompt = state.pendingFollowUpPrompt;
    state.pendingFollowUpPrompt = null;
    if (state.lastCompactFromCommand) return;
    // omp retries the turn itself after an overflow or a cut-off reply.
    if (details.willRetry) return;
    const stats = state.lastStats;
    if (!stats) return;
    scheduleCompactionStatsNotify(ctx, stats);
    // omp resumes an interrupted run by itself after automatic maintenance
    // (compaction.autoContinue); only a /compact follow-up prompt is sent here.
    if (followUpPrompt) {
      try {
        await pi.sendUserMessage(followUpPrompt);
      } catch {}
    }
  });
};
