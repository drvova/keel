// Host-agnostic compaction hook. Nothing here imports a host package at runtime:
// the host's own functions arrive through a CompactionHost, so the same code runs
// natively on Pi (src/hooks/before-compact.ts) and on omp (src/omp/).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { compileRanked } from "../core/summarize";
import { mergeHistoryIndex, rangeOfWindow, readHistoryIndex, unindexedRange } from "../core/history-index";
import { readPins } from "../core/pins";
import { normalize } from "../core/normalize";
import { buildGlobalIndexById, loadGlobalIndexById } from "../core/global-indices";
import { parseKeepAndPrompt, PI_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";
import { loadSettings, type PiVccSettings } from "../core/settings";
import { calibrateCharsPerToken, estimateMessageContentChars, estimateMessageContentTokens, estimateTokensFromChars } from "../core/token-estimate";
import type { PiVccCompactionDetails } from "../details";
import type { CompactionReason } from "../types";

export { PI_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";

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

export type BudgetCutKind = "no_anchor" | "oversized_tail";
export const OVERSIZED_TAIL_FACTOR = 2.5;

/** What the compaction hook needs from the host it runs in. */
export interface CompactionHost {
  /** The host's convertToLlm; pi-vcc calls it with one message at a time. */
  convertToLlm: (messages: any[]) => any[];
  /**
   * The host's projection for branches with context edits (Pi's
   * buildSessionProjection). Read when such a branch is compacted; undefined on
   * hosts that have none.
   */
  readonly buildSessionProjection?: (entries: any[]) => { entries: Array<{ sourceEntry: any; messages: any[] }> };
  /**
   * Whether pi-vcc sends its own continue after an automatic compaction, given
   * the user's `continueAfterThresholdCompact`. Omit it on a host that always
   * resumes by itself: pi-vcc then registers no continue machinery at all.
   */
  shouldAutoContinue?: (settingEnabled: boolean) => boolean;
  /**
   * Trigger reason for a compaction whose session_before_compact event does not
   * carry one (omp). Called once per hook run.
   */
  compactionContext?: () => { reason?: CompactionReason; willRetry?: boolean } | undefined;
}

/** Per-registration state. omp binds the factory again for every subagent, so it gets one per binding. */
export interface CompactionState {
  lastStats: CompactionStats | null;
  lastCompactWasPiVcc: boolean;
  pendingFollowUpPrompt: string | null;
  pendingAutoContinueTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The /pi-vcc marker for the manual compaction a command is starting, on a
   * host whose ctx.compact() cannot carry instructions together with callbacks
   * (omp). The hook reads it for a manual pass that arrives without instructions.
   */
  pendingManualInstructions: string | null;
}

export const createCompactionState = (): CompactionState => ({
  lastStats: null,
  lastCompactWasPiVcc: false,
  pendingFollowUpPrompt: null,
  pendingAutoContinueTimer: null,
  pendingManualInstructions: null,
});

const defaultState = createCompactionState();

// One host per process: an entry point installs its own before anything runs.
// The cut helpers below fall back to it when no host is passed.
let defaultHost: CompactionHost | undefined;

export const setDefaultCompactionHost = (host: CompactionHost): void => {
  defaultHost = host;
};

const resolveHost = (host?: CompactionHost): CompactionHost => {
  const resolved = host ?? defaultHost;
  if (!resolved) throw new Error("pi-vcc: no compaction host installed");
  return resolved;
};

// Invisible auto-continue: resume the agent after compaction without polluting
// the LLM context with a user-visible continue prompt. triggerInvisibleContinue
// sends a custom message marked with a dedicated customType (content:[],
// display:false, triggerTurn:true, deliverAs:'followUp') so Pi's queue/busy-state
// stays coherent; the on('context') filter registered in registerBeforeCompactHook
// removes that message (by customType ONLY) from the LLM payload — the model
// simply continues from the compaction summary.
//
// Ported from monotykamary/pi-vcc branch 'tom'
// (https://github.com/monotykamary/pi-vcc, MIT) — a pi-vcc derivative.
export const AUTO_CONTINUE_CUSTOM_TYPE = "pi-vcc-auto-continue";

/**
 * First Pi version that resumes the run by itself after an automatic compaction.
 * From this version on pi-vcc's fallback continue is redundant, and because it is
 * scheduled blind (setTimeout(0), no idle check) it lands as a ghost turn once the
 * self-resumed run ends - see issue #22, which reports both behaviours on 0.84.4.
 * Kept as a [major, minor, patch] tuple so there is one source of truth.
 */
export const PI_SELF_RESUME_VERSION: readonly [number, number, number] = [0, 84, 4];

/**
 * Minimal semver core parse: [major, minor, patch], or null when unusable.
 * Prerelease/build suffixes are dropped, so 0.84.4-rc.1 counts as 0.84.4 - the
 * safe direction, since such a build already carries the self-resume behaviour.
 */
const parseVersionCore = (version: unknown): [number, number, number] | null => {
  if (typeof version !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/**
 * Two keys must both turn for pi-vcc to send its own continue:
 *  - `settingEnabled` is the user's permission (`continueAfterThresholdCompact`);
 *    false always wins.
 *  - the running Pi must be old enough to still need the fallback.
 * An unreadable/malformed version fails safe to "no continue": a missing continue
 * costs one idle turn, a ghost turn corrupts the transcript.
 */
export const shouldScheduleAutoContinue = (settingEnabled: boolean, piVersion: unknown): boolean => {
  if (!settingEnabled) return false;
  const running = parseVersionCore(piVersion);
  if (!running) return false;
  for (let i = 0; i < 3; i++) {
    if (running[i] !== PI_SELF_RESUME_VERSION[i]) return running[i] < PI_SELF_RESUME_VERSION[i];
  }
  return false;
};

export const triggerInvisibleContinue = (pi: ExtensionAPI): void => {
  pi.sendMessage(
    {
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: [],
      display: false,
      details: undefined,
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );
};

const clearPendingAutoContinue = (state: CompactionState) => {
  if (state.pendingAutoContinueTimer) {
    clearTimeout(state.pendingAutoContinueTimer);
    state.pendingAutoContinueTimer = null;
  }
};

const scheduleAutoContinue = (pi: any, state: CompactionState) => {
  clearPendingAutoContinue(state);
  state.pendingAutoContinueTimer = setTimeout(() => {
    state.pendingAutoContinueTimer = null;
    try {
      triggerInvisibleContinue(pi);
    } catch {}
  }, 0);
};

/** Stats of the last pi-vcc compaction on the default (Pi) registration. */
export const getLastCompactionStats = () => defaultState.lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

export const formatCompactionStats = (stats: CompactionStats): string => {
  if (stats.budgetCut) {
    const reason = stats.budgetCut === "no_anchor" ? "no user anchor" : "oversized tail";
    return `pi-vcc: kept ~${formatTokens(stats.keptTokensEst)} tok tail (mid-turn cut, ${reason}), summarized ${stats.summarized}.`;
  }
  const notes: string[] = [`summarized ${stats.summarized}`];
  if (stats.smartKeepAdjusted) {
    notes.push("smart-keep");
  }
  return `pi-vcc: kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns, ~${formatTokens(stats.keptTokensEst)} tok (${notes.join(", ")}).`;
};

const COMPACTION_REASONS: readonly CompactionReason[] = ["manual", "threshold", "overflow", "idle", "incomplete"];

const toCompactionReason = (value: unknown): CompactionReason | undefined =>
  COMPACTION_REASONS.includes(value as CompactionReason) ? (value as CompactionReason) : undefined;

/** Pi puts the trigger on the event; a host that does not (omp) supplies it through compactionContext. */
const readCompactionEventContext = (
  event: unknown,
  fallback?: { reason?: CompactionReason; willRetry?: boolean },
): { reason?: CompactionReason; willRetry: boolean } => {
  const raw = event as { reason?: unknown; willRetry?: unknown };
  const reason = toCompactionReason(raw.reason);
  if (reason) return { reason, willRetry: raw.willRetry === true };
  return { reason: toCompactionReason(fallback?.reason), willRetry: raw.willRetry === true || fallback?.willRetry === true };
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
  isPiVcc: boolean;
  keepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  followUpPrompt: string | null;
} => {
  const trimmed = customInstructions?.trim();
  if (trimmed === PI_VCC_COMPACT_INSTRUCTION) {
    return { isPiVcc: true, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
  }

  const keepPrefix = `${PI_VCC_COMPACT_INSTRUCTION} `;
  if (trimmed?.startsWith(keepPrefix)) {
    const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
    return {
      isPiVcc: true,
      keepUserTurns: parsed.keepUserTurns ?? 1,
      keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
      followUpPrompt: null,
    };
  }

  const parsed = parseKeepAndPrompt(customInstructions);
  return {
    isPiVcc: false,
    keepUserTurns: parsed.keepUserTurns ?? 1,
    keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
    followUpPrompt: parsed.followUpPrompt || null,
  };
};

const normalizeKeepUserTurns = (keepUserTurns: number): number => {
  if (!Number.isFinite(keepUserTurns)) return 0;
  return Math.max(0, Math.floor(keepUserTurns));
};

const dbg = (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2)); } catch {}
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
 *   custom message to a developer message; it is read back as user content, as on Pi.
 * - omp's developer-role turns (host reminders) and @file mention contents are
 *   host context, not conversation, and are left out.
 */
const toSummaryMessage = (message: any, host: CompactionHost): any | null => {
  const role = message?.role;
  if (role === "developer" || role === "fileMention") return null;
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
// branch_summary) into its agent-message form, mirroring pi-core's
// createCustomMessage / createBranchSummaryMessage (not root-exported, so inlined).
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

const collectLiveMessages = (branchEntries: any[], host?: CompactionHost): EntryWithMessage[] => {
  if (branchEntries.some((entry) => entry.type === "context_edit")) {
    // Pi owns edit ordering and compaction visibility. Keep source ids for recall
    // refs, but use projected messages for summaries, calibration and tail cuts.
    // The Pi host reads the export at call time, which preserves loading on older
    // supported hosts without it. If edited history reaches such a host, defer via
    // the hook error rather than silently resurrecting omitted/replaced content.
    const project = resolveHost(host).buildSessionProjection;
    if (typeof project !== "function") throw new Error("Context-edited history requires Pi's buildSessionProjection");
    return project(branchEntries).entries.flatMap(({ sourceEntry: entry, messages }: any) =>
      entry.type === "compaction" ? [] : messages.map((message: any) => ({ entry, message })),
    );
  }

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
  branchEntries: any[],
  keepUserTurns = 1,
  skipCustomTypes: readonly string[] = [],
  hostArg?: CompactionHost,
): OwnCutResult {
  const host = resolveHost(hostArg);
  const normalizedKeepUserTurns = normalizeKeepUserTurns(keepUserTurns);
  const liveMessages = collectLiveMessages(branchEntries, host);

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
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return compactAll(true);
  }

  // A prefix that renders no block would compile to "", storing an empty summary
  // while keeping every message: context never shrinks and the next agent_end
  // re-triggers compaction indefinitely. Pi 1.0 persists the prompt/tool loadout
  // as a role:"system" entry (agent-session _preparePromptAndToolLoadout) that
  // renders nothing, so when it alone precedes the first user message the prefix
  // is empty; a custom_message listed in skipCustomTypes does the same. Fall back
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
// non-toolResult boundary, mirroring pi-core's findCutPoint.
export const findBudgetCutIndex = (
  live: EntryWithMessage[],
  maxTokens: number,
  charsPerToken?: number,
): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += estimateMessageContentTokens(live[i].message.content, charsPerToken);
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

/** An assistant message that ends a turn: text, and no tool call still waiting for its result. */
const isFinalAnswer = (message: { role: string; content: unknown }): boolean =>
  message.role === "assistant" &&
  Array.isArray(message.content) &&
  message.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") &&
  !message.content.some((part: any) => part?.type === "toolCall");

export const applyTailBudget = (
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens?: number; oversizedFactor?: number; charsPerToken?: number; skipCustomTypes?: readonly string[]; host?: CompactionHost } = {},
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const host = resolveHost(opts.host);
  const live = collectLiveMessages(branchEntries, host);
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
    if (idx >= 0) return renders(idx) ? budgetResult(idx, "no_anchor") : cut;
    // The whole window fits the budget. When it ends with the turn's final
    // answer, keep that answer and summarize the rest: compact-all would take the
    // reply out of context too, and a host that reads the last assistant message
    // back (omp's print mode prints it) would then have nothing.
    const last = live.length - 1;
    if (last > 0 && isFinalAnswer(live[last].message) && renders(last)) return budgetResult(last, "no_anchor");
    return cut;
  }

  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
  // maxTokens * factor (tolerance zone below is unchanged).
  const tailStart = cut.messages.length; // equals the cut index in the live window
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) {
    tailTokens += estimateMessageContentTokens(live[i].message.content, opts.charsPerToken);
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
  host?: CompactionHost;
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
  host: CompactionHost | undefined,
): number | null => {
  const cut = buildOwnCut(branchEntries, keepUserTurns, [], host);
  if (!cut.ok || cut.compactAll) return null;
  const idx = branchEntries.findIndex((e: any) => e.id === cut.firstKeptEntryId);
  if (idx < 0) return null;
  const kept = branchEntries.slice(idx).filter((e: any) => e.type === "message");
  const chars = kept.reduce(
    (sum: number, e: any) => sum + estimateMessageContentChars(e.message?.content),
    0,
  );
  return estimateTokensFromChars(chars, charsPerToken);
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

  const baseCut = buildOwnCut(opts.branchEntries, baseKeep, [], opts.host);
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

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
};

/** pi-vcc stamps details.compactor; omp's notes-backed rollover nests hook details under hookDetails. */
const isPiVccCompactionEntry = (entry: any): boolean =>
  entry?.details?.compactor === "pi-vcc" || entry?.details?.hookDetails?.compactor === "pi-vcc";

/**
 * Register the compaction hook on `pi` for `host`. `state` defaults to the
 * module's own (what getLastCompactionStats reads); a host that binds the
 * factory once per session, like omp, passes a fresh one per binding.
 */
export const registerCompactionHook = (
  pi: ExtensionAPI,
  host: CompactionHost,
  state: CompactionState = defaultState,
) => {
  const { shouldAutoContinue } = host;
  if (shouldAutoContinue) {
    // Filter our invisible-continue marker out of the LLM context payload so the
    // model just continues from the compaction summary (matched by customType ONLY).
    // Only registered where pi-vcc can send that marker: a context handler makes
    // some hosts (omp) deep-copy the whole context before every request.
    pi.on("context", (event) => {
      const messages = event.messages.filter((message) => {
        if (message.role !== "custom") return true;
        return message.customType !== AUTO_CONTINUE_CUSTOM_TYPE;
      });
      if (messages.length !== event.messages.length) return { messages };
    });

    pi.on("before_agent_start", () => {
      clearPendingAutoContinue(state);
    });
  }

  pi.on("session_before_compact", (event, ctx) => {
    const { preparation, branchEntries } = event;
    const { reason, willRetry } = readCompactionEventContext(event, host.compactionContext?.());
    const customInstructions = event.customInstructions
      ?? ((reason ?? "manual") === "manual" ? state.pendingManualInstructions ?? undefined : undefined);
    const settings = loadSettings();

    // Always handle explicit /pi-vcc marker.
    // Otherwise, only handle when user opted in via settings.
    const { isPiVcc, keepUserTurns, keepUserTurnsExplicit, followUpPrompt } = parseCompactionInstructions(customInstructions);
    state.pendingFollowUpPrompt = null;
    if (!isPiVcc && !settings.overrideDefaultCompaction) return;
    // Provider-level opt-out (#27): defer to the provider's own compaction
    // (e.g. remote compaction via pi-codex-compaction). Checked at call time
    // because the model can change mid-session via /model. Explicit /pi-vcc
    // bypasses the skip; undefined model never skips.
    const provider = (ctx as any)?.model?.provider;
    if (!isPiVcc && typeof provider === "string" &&
        settings.skipForProviders.some((p) => p.toLowerCase() === provider.toLowerCase())) return;

    const calibrationCut = buildOwnCut(branchEntries as any[], 0, [], host);
    const calibrationMessageChars = calibrationCut.ok
      ? calibrationCut.messages.reduce(
          (sum: number, message: any) => sum + estimateMessageContentChars(message.content),
          0,
        )
      : 0;
    const calibrationSummaryChars = typeof preparation.previousSummary === "string"
      ? preparation.previousSummary.length
      : 0;
    const tokenEstimate = calibrateCharsPerToken(
      calibrationMessageChars + calibrationSummaryChars,
      preparation.tokensBefore,
    );

    // Smart keep-tail: boost default keep when the tail is small.
    // Explicit keep:N from the user is always respected (resolver no-ops).
    const smartKeep = resolveSmartKeepUserTurns({
      branchEntries: branchEntries as any[],
      requestedKeepUserTurns: keepUserTurnsExplicit ? keepUserTurns : null,
      explicit: keepUserTurnsExplicit,
      smartKeepTail: settings.smartKeepTail,
      charsPerToken: tokenEstimate.charsPerToken,
      host,
    });
    let ownCut = buildOwnCut(branchEntries as any[], smartKeep.keepUserTurns, settings.skipCustomTypes, host);
    // Default path only: rescue autonomous / oversized-tail sessions with a
    // token-budget cut. Explicit keep:N is respected absolutely (no-op here).
    if (ownCut.ok && !keepUserTurnsExplicit) {
      ownCut = applyTailBudget(branchEntries as any[], ownCut, {
        charsPerToken: tokenEstimate.charsPerToken,
        skipCustomTypes: settings.skipCustomTypes,
        host,
      });
    }
    // An automatic pass on a turn still running (its last message is a tool result:
    // omp compacts between the tool calls of one turn) whose live window has no
    // earlier user turn and fits the tail budget: the only cut left is compact-all,
    // which would summarize away the request and tool output the agent is working
    // from, to free a few tokens. Leave the turn alone: a recovery pass (overflow,
    // cut-off reply) goes to the host's own method, a threshold or idle pass waits
    // until the turn has ended.
    if (
      ownCut.ok && ownCut.compactAll && ownCut.keepFallbackToCompactAll && !isPiVcc
      && ownCut.messages[ownCut.messages.length - 1]?.role === "toolResult"
      && (reason === "threshold" || reason === "idle" || reason === "overflow" || reason === "incomplete")
    ) {
      state.pendingFollowUpPrompt = null;
      const toHost = reason === "overflow" || reason === "incomplete" || willRetry;
      dbg(settings, {
        deferredRunningTurn: true,
        fallbackToCore: toHost,
        compaction: { reason, willRetry },
        liveMessages: ownCut.messages.length,
      });
      return toHost ? undefined : { cancel: true };
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
      const fallbackToCore = !isPiVcc && (reason === "overflow" || willRetry);
      dbg(settings, {
        cancelled: !fallbackToCore,
        fallbackToCore,
        reason: ownCut.reason,
        compaction: { reason, willRetry },
        isPiVcc,
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
    const keptChars = keptEntries.reduce(
      (sum: number, e: any) => sum + estimateMessageContentChars(e.message?.content),
      0,
    );
    state.lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      requestedKeepUserTurns: ownCut.requestedKeepUserTurns,
      keepUserTurnsExplicit,
      keepFallbackToCompactAll: ownCut.keepFallbackToCompactAll,
      keptTokensEst: estimateTokensFromChars(keptChars, tokenEstimate.charsPerToken),
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
    const RANKED_BRIEF_BUDGET_TOKENS = 1100;
    const RANKED_BRIEF_CEILING_TOKENS = 2000;
    const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;
    // [History Index]: this window's range added to the one the previous pi-vcc
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
        )
      : undefined;

    const pinnedNotes = readPins(branchEntries as any[]);

    const summary = compileRanked({
      messages,
      sourceIndices,
      historyIndex,
      pinnedNotes,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
      trackCommands: settings.trackCommands,
      ranking: {
        maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * tokenEstimate.charsPerToken),
        maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * tokenEstimate.charsPerToken),
        briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * tokenEstimate.charsPerToken),
      },
    });

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

    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      // version 2 = refs are session-global (recall index space); version 1
      // summaries carried window-relative refs (issue #28).
      version: 2,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      reason,
      willRetry,
      ...(historyIndex ? { historyIndex } : {}),
    };

    state.lastCompactWasPiVcc = isPiVcc;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  // Fire success toast for /compact path only (delayed to let UI settle).
  // /pi-vcc path uses its own onComplete callback in the command handler.
  pi.on("session_compact", async (event, ctx) => {
    if (!event.fromExtension) return;
    // The runner keeps the LAST non-null session_before_compact result, so
    // another compaction extension can win even when pi-vcc also returned one.
    // Read the truth from the persisted entry instead of lifecycle state:
    // pi-vcc stamps details.compactor = "pi-vcc" on its own compactions.
    const entry = (event as any).compactionEntry;
    if (!isPiVccCompactionEntry(entry)) return;
    // Pi puts the trigger on this event. On a host that does not (one with
    // compactionContext), the entry's own details, stamped by the hook above,
    // carry it.
    const stamped = host.compactionContext
      ? (entry?.details?.compactor === "pi-vcc" ? entry.details : entry?.details?.hookDetails)
      : undefined;
    const { reason, willRetry } = readCompactionEventContext(event, stamped);
    const followUpPrompt = state.pendingFollowUpPrompt;
    state.pendingFollowUpPrompt = null;
    if (state.lastCompactWasPiVcc) return; // /pi-vcc handles its own toast via onComplete
    if (willRetry) return;
    const stats = state.lastStats;
    if (!stats) return;
    const shouldContinueAfterAutoCompact = (reason === "threshold" || reason === "overflow")
      && shouldAutoContinue?.(loadSettings().continueAfterThresholdCompact) === true;
    scheduleCompactionStatsNotify(ctx, stats);
    if (followUpPrompt) {
      try {
        await pi.sendUserMessage(followUpPrompt);
      } catch {}
    } else if (shouldContinueAfterAutoCompact) {
      scheduleAutoContinue(pi, state);
    }
  });
};
