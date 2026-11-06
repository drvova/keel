// Where a compaction cuts: the live window, the cut at a kept user turn, the
// token-budget cuts that rescue a missing or oversized tail, a running turn's
// newest steps, the whole window, and smart keep-tail. Pure: what the host does
// comes in as its convertToLlm.
import { estimateMessageChars, estimateMessageTokens, estimateTokensFromChars } from "../core/token-estimate";
import { lastCompactionIndex, lastResetIndex } from "../core/session-file";
import { prefixHasRenderableContent, toLiveMessage, type ConvertToLlm, type EntryWithMessage } from "./summary-input";

/**
 * no_anchor: no user turn to cut at, so a token-budget cut inside the turn.
 * oversized_tail: the kept user turns were too big, cut inside them.
 * running_turn: a recovery pass on a turn still running, with no earlier user
 *   turn: its newest steps kept, the request and earlier steps summarized.
 * final_reply: a finished turn with no earlier user turn, small enough to keep
 * whole: everything but its final reply is summarized.
 */
export type BudgetCutKind = "no_anchor" | "oversized_tail" | "final_reply" | "running_turn";
const OVERSIZED_TAIL_FACTOR = 2.5;

const normalizeKeepUserTurns = (keepUserTurns: number): number => {
  if (!Number.isFinite(keepUserTurns)) return 0;
  return Math.max(0, Math.floor(keepUserTurns));
};

/** Chars of what stays in context from these entries: every live message, whatever its shape (custom messages and branch summaries included). */
export const keptChars = (entries: any[]): number =>
  entries.reduce((sum: number, e: any) => {
    const m = toLiveMessage(e);
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
      /** Compact-all because keep:N found no boundary, not because keep:0 asked for it: a tail budget may still keep some. */
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: OwnCutCancelReason };

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
  const resetIdx = lastResetIndex(branchEntries);
  const compactionIdx = lastCompactionIndex(branchEntries);
  if (compactionIdx < 0) return resetIdx + 1;

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

export const collectLiveMessages = (branchEntries: any[]): EntryWithMessage[] => {
  const liveMessages: EntryWithMessage[] = [];
  for (let i = liveWindowStart(branchEntries); i < branchEntries.length; i++) {
    const e = branchEntries[i];
    const m = toLiveMessage(e);
    if (m) liveMessages.push({ entry: e, message: m });
  }
  return liveMessages;
};

type Cut = Extract<OwnCutResult, { ok: true }>;

const userTurns = (live: readonly EntryWithMessage[]): number => live.filter((m) => m.message.role === "user").length;

/** Everything before live index `idx` summarized, the rest kept. */
const cutAt = (live: EntryWithMessage[], idx: number, budgetCut?: BudgetCutKind): Cut => ({
  ok: true,
  messages: live.slice(0, idx).map((m) => m.message),
  selectedIds: live.slice(0, idx).map((m) => m.entry.id),
  firstKeptEntryId: live[idx].entry.id,
  compactAll: false,
  keptUserTurns: userTurns(live.slice(idx)),
  totalUserTurns: userTurns(live),
  keepFallbackToCompactAll: false,
  ...(budgetCut ? { budgetCut } : {}),
});

/**
 * The whole live window summarized. firstKeptEntryId "" is a sentinel: omp's
 * buildSessionContext matches no entry (none kept from before the compaction),
 * and the next cut starts after the compaction entry (liveWindowStart).
 */
const compactAllOf = (live: EntryWithMessage[], keepFallbackToCompactAll: boolean): Cut => ({
  ok: true,
  messages: live.map((e) => e.message),
  selectedIds: live.map((e) => e.entry.id),
  firstKeptEntryId: "",
  compactAll: true,
  keptUserTurns: 0,
  totalUserTurns: userTurns(live),
  keepFallbackToCompactAll,
});

export function buildOwnCut(
  convert: ConvertToLlm,
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
  // nothing to compact.
  if (!prefixHasRenderableContent(liveMessages, skipCustomTypes, convert)) return { ok: false, reason: "no_live_messages" };

  const userIndices = liveMessages.reduce<number[]>((acc, e, i) => {
    if (e.message.role === "user") acc.push(i);
    return acc;
  }, []);

  if (normalizedKeepUserTurns <= 0) return compactAllOf(liveMessages, false);

  // Summarize all messages before the requested kept user-turn tail.
  const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;

  if (cutIdx <= 0) {
    // Keep request cannot form a safe boundary (single user prompt, no user prompt,
    // or keep larger than available user turns), so compact everything and keep no tail.
    return compactAllOf(liveMessages, true);
  }

  // A prefix that renders no block would compile to "", storing an empty summary
  // while keeping every message: context never shrinks and the next agent_end
  // re-triggers compaction indefinitely. A role:"system" entry renders nothing
  // (omp's convertToLlm drops it; Pi's passes it through and normalize skips
  // it), so when it alone precedes the first user message the prefix is empty;
  // a custom_message listed in skipCustomTypes does the same. Fall back to
  // compact-all, the same path already used when no safe boundary exists;
  // applyTailBudget then decides the tail.
  if (!prefixHasRenderableContent(liveMessages.slice(0, cutIdx), skipCustomTypes, convert)) return compactAllOf(liveMessages, true);

  return cutAt(liveMessages, cutIdx);
}

// Token-budget tail cut: rescue default-path sessions when the user-turn
// anchored tail is absent (autonomous: no user boundary in the live window)
// or oversized (a single giant last user turn). Cuts at the nearest valid
// non-toolResult boundary, like omp's own cut point.
const findBudgetCutIndex = (
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
  convert: ConvertToLlm,
  branchEntries: any[],
  opts: { maxTokens: number; charsPerToken?: number; skipCustomTypes?: readonly string[] },
): OwnCutResult | undefined => {
  const live = collectLiveMessages(branchEntries);
  const tokens = live.map((m) => estimateMessageTokens(m.message, opts.charsPerToken));
  const target = Math.min(opts.maxTokens, tokens.reduce((a, b) => a + b, 0) / 2);
  let tail = 0;
  let best = -1;
  for (let i = live.length - 1; i >= 1; i--) {
    tail += tokens[i];
    if (tail > target) break;
    if (live[i].message.role !== "toolResult") best = i;
  }
  if (best < 1 || !prefixHasRenderableContent(live.slice(0, best), opts.skipCustomTypes ?? [], convert)) return undefined;
  return cutAt(live, best, "running_turn");
};

/**
 * One or two live messages, summarized whole: on a recovery pass something must
 * shrink, and a request or reply far too big for the window (a long paste, one
 * huge result) shrinks to its summary line, its original in recall.
 */
export const wholeWindowCut = (convert: ConvertToLlm, branchEntries: any[], skipCustomTypes: readonly string[] = []): OwnCutResult | undefined => {
  const live = collectLiveMessages(branchEntries);
  if (live.length === 0 || !prefixHasRenderableContent(live, skipCustomTypes, convert)) return undefined;
  return compactAllOf(live, false);
};

/** An assistant message that ends a turn: text, and no tool call still waiting for its result. */
const isFinalAnswer = (message: { role: string; content: unknown }): boolean =>
  message.role === "assistant" &&
  Array.isArray(message.content) &&
  message.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") &&
  !message.content.some((part: any) => part?.type === "toolCall");

export const applyTailBudget = (
  convert: ConvertToLlm,
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens: number; charsPerToken?: number; skipCustomTypes?: readonly string[] },
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens;
  const live = collectLiveMessages(branchEntries);
  // Same guard as buildOwnCut, for the compact-all re-cut: a budget cut right
  // after a lone system entry (first user message alone over budget) would
  // summarize nothing. Case B never needs it: its cut extends a prefix that
  // already renders.
  const renders = (idx: number) => prefixHasRenderableContent(live.slice(0, idx), opts.skipCustomTypes ?? [], convert);

  // Case A: no user anchor → compact-all. Re-cut to a token budget unless the
  // compact-all came from explicit keep:0 (which must be respected absolutely).
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    // A cut that keeps only the turn's final answer kept a finished turn's reply, not part of a running one.
    if (idx >= 0) {
      if (!renders(idx)) return cut;
      return cutAt(live, idx, idx === live.length - 1 && isFinalAnswer(live[idx].message) ? "final_reply" : "no_anchor");
    }
    // The whole window fits the budget. When it ends with the turn's final
    // answer, keep that answer and summarize the rest: compact-all would take the
    // reply out of context too, and omp's print mode, which prints the last
    // assistant message, would then have nothing.
    const last = live.length - 1;
    if (last > 0 && isFinalAnswer(live[last].message) && renders(last)) return cutAt(live, last, "final_reply");
    return cut;
  }

  // Case B: oversized user-boundary tail.
  const tailStart = cut.messages.length; // equals the cut index in the live window
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) {
    tailTokens += estimateMessageTokens(live[i].message, opts.charsPerToken);
  }
  if (tailTokens <= maxTokens * OVERSIZED_TAIL_FACTOR) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
  if (idx <= tailStart) return cut;
  return cutAt(live, idx, "oversized_tail");
};

export interface ResolveSmartKeepOptions {
  branchEntries: any[];
  /** keep:N the user typed, always respected; null when none was (the default path). */
  requestedKeepUserTurns: number | null;
  smartKeepTail: boolean;
  /** As the cut takes them: a tail measured without them can grow past a prefix that renders nothing. */
  skipCustomTypes: readonly string[];
  /** The budgets' minTailTokens and maxTailTokens. */
  minTokens: number;
  maxTokens: number;
  /** Calibrated chars/token for the current session; defaults to heuristic when omitted. */
  charsPerToken?: number;
  convert: ConvertToLlm;
}

interface ResolveSmartKeepResult {
  keepUserTurns: number;
  smartAdjusted: boolean;
}

/**
 * Null when keep:N would trigger compact-all (tail lost) or cancel, so the
 * resolver can stop growing instead of selecting a value that discards the
 * tail entirely.
 */
const tailTokensForKeep = (opts: ResolveSmartKeepOptions, keepUserTurns: number): number | null => {
  const { branchEntries, charsPerToken } = opts;
  const cut = buildOwnCut(opts.convert, branchEntries, keepUserTurns, opts.skipCustomTypes);
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
  const { minTokens, maxTokens } = opts;
  const baseKeep = opts.requestedKeepUserTurns ?? 1;

  if (opts.requestedKeepUserTurns !== null || !opts.smartKeepTail) {
    return { keepUserTurns: baseKeep, smartAdjusted: false };
  }

  const baseTokens = tailTokensForKeep(opts, baseKeep);
  // base tail already above min (or unmeasurable / compact-all) → don't grow.
  if (baseTokens == null || baseTokens > minTokens) {
    return { keepUserTurns: baseKeep, smartAdjusted: false };
  }

  const baseCut = buildOwnCut(opts.convert, opts.branchEntries, baseKeep, opts.skipCustomTypes);
  const totalUserTurns = baseCut.ok ? baseCut.totalUserTurns : 0;

  let selected = baseKeep;
  for (let k = baseKeep + 1; k <= totalUserTurns; k++) {
    const tokens = tailTokensForKeep(opts, k);
    if (tokens == null || tokens > maxTokens) break;
    selected = k;
  }

  return {
    keepUserTurns: selected,
    smartAdjusted: selected !== baseKeep,
  };
};
