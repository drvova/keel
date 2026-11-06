// What a compaction does: first what it is sized for (the host's trigger under
// its policy, the context's overhead and chars per token, the budgets), then where it cuts
// (smart keep-tail, the cut, its token-budget rescues, a running turn's newest
// steps, the whole window), what it writes (assemble.ts) and whether that is
// worth writing (the growth guard). Pure: the host's convertToLlm comes in,
// and the hook (src/hooks/compaction.ts) acts on the plan. The Lisp core makes
// the same plan (lisp/src/compaction.lisp, op compact).
import type { FileOps, CompactionReason } from "../types";
import { compactionBudgets, triggerFor, type CompactionBudgets, type TriggerRule } from "../core/window";
import type { VccSettings } from "../core/settings";
import type { ConvertToLlm } from "../host";
import { calibrateCharsPerToken, DEFAULT_CHARS_PER_TOKEN, estimateMessageChars, estimateTokensFromChars } from "../core/token-estimate";
import { applyTailBudget, buildOwnCut, collectLiveMessages, keptChars, resolveSmartKeepUserTurns, runningTurnCut, wholeWindowCut, type OwnCutCancelReason, type OwnCutResult } from "./cut";
import { assembleSummary } from "./assemble";
import { toLiveMessage, toSummaryMessage } from "./summary-input";
import { restoreOriginals } from "../core/raw-store";
import { callCore } from "../core/lisp-core";
import type { CompactionStats } from "./stats";

export interface PlanInput {
  /** The branch as the context holds it. */
  branchEntries: any[];
  convert: ConvertToLlm;
  /** keep:N the user typed; null when none was. */
  keepUserTurns: number | null;
  /** Started by /omp-vcc. */
  fromCommand: boolean;
  reason: CompactionReason;
  /** A pass that must shrink the context (an overflow, a cut-off reply). */
  recovering: boolean;
  settings: Pick<VccSettings, "skipCustomTypes" | "trackCommands" | "smartKeepTail" | "workingSet">;
  /** The host's compaction rule (core/window.ts). */
  rule: TriggerRule;
  /** The effective context window, when one is known. */
  window: number | undefined;
  /** The context as the host counted it. */
  tokensBefore: number;
  /** The host's compaction policy as it came with the event (`preparation.settings`). */
  hostSettings: unknown;
  /** A pass omp-vcc started itself, with the context it measured then. */
  selfStarted?: { usedTokens?: number };
  sessionFile: string | undefined;
  indexById: Map<string, number> | undefined;
  previousSummary: string | undefined;
  fileOps: FileOps;
}

export const CUT_CANCEL_NOTICES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "omp-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "omp-vcc: Too few messages to compact",
};

/** What a compaction was sized from: the host's policy, its trigger, the context's overhead and chars per token, the budgets. */
export interface Sizing {
  policy: object | undefined;
  trigger: number | undefined;
  overheadTokens: number;
  tokenEstimate: ReturnType<typeof calibrateCharsPerToken>;
  budgets: CompactionBudgets;
}

export type Plan = (
  /** A pass omp-vcc started itself that the host's current policy no longer calls for. */
  | { kind: "cancel"; why: "policy" }
  /** A recovery pass with nothing omp-vcc can summarize: the host's own method takes it. */
  | { kind: "step_aside"; cutReason: OwnCutCancelReason; liveRoles: string[] }
  /** Not compacted; `notice` says why, when the user should be told. */
  | { kind: "cancel"; why: "running_turn" | "no_cut" | "growth"; notice?: string; cutReason?: OwnCutCancelReason; liveRoles?: string[]; growth?: unknown; summarized?: number }
  | {
      kind: "compact";
      summary: string;
      firstKeptEntryId: string;
      sections: string[];
      summaryState: unknown;
      /** Messages the summary covers. */
      summarized: number;
      historyIndex?: unknown[];
      workingSet?: number[];
      stats: CompactionStats;
      budgetCut?: string;
      /** The cut summarized everything (no kept tail). */
      compactAll: boolean;
      /** Written although it grows the context: a recovery pass keeping part of the window. */
      writtenForRescue?: { growth: unknown; summarized: number };
      /** The running turn's newest steps were kept on a recovery pass. */
      runningTurnRecovery?: boolean;
    }
) & { sizing: Sizing };

const liveRoles = (branchEntries: any[]): string[] => {
  const live = collectLiveMessages(branchEntries).map((m) => m.message.role);
  return live.length <= 30 ? live : [...live.slice(0, 10), "...", ...live.slice(-10)];
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

/**
 * The context as a compaction sizes it: chars per token calibrated on the
 * messages, and what a compaction cannot remove (system prompt, tool schemas).
 * The session's first request measured that: its prompt held little else.
 * Without one, the provider-counted context less what the messages account for
 * at 4 chars/token, which overstates it for dense text. Then where the host
 * compacts next under its policy, and the budgets for landing below it.
 */
const sizeCompaction = (input: PlanInput): Sizing => {
  const { branchEntries, tokensBefore, previousSummary, rule } = input;
  const messageChars = collectLiveMessages(branchEntries).reduce((sum, m) => sum + estimateMessageChars(m.message), 0);
  const contentChars = messageChars + (previousSummary?.length ?? 0);
  const measured = measuredOverheadTokens(branchEntries);
  // Calibrated on the messages alone where the overhead is known, so a summary's
  // token budget maps to the chars the messages actually take.
  const tokenEstimate = calibrateCharsPerToken(contentChars, measured !== undefined && tokensBefore > measured ? tokensBefore - measured : tokensBefore);
  const overheadTokens = measured
    ?? (tokensBefore > 0 ? Math.max(0, tokensBefore - estimateTokensFromChars(contentChars, DEFAULT_CHARS_PER_TOKEN)) : 0);
  const policy = rule.policyOf(input.hostSettings);
  const trigger = triggerFor(input.window, input.recovering, tokensBefore, policy, rule);
  const budgets = compactionBudgets(trigger, overheadTokens, input.settings.workingSet);
  return { policy, trigger, overheadTokens, tokenEstimate, budgets };
};

/**
 * What the Lisp core needs of the host for each branch entry: its #N, and what
 * convertToLlm makes of its live message for the summary (toSummaryMessage), as
 * it is and, where omp rewrote it, as the original omp-vcc kept. The core does
 * the rest (lisp/src/compaction.lisp).
 */
const hostNotes = (input: PlanInput): Array<Record<string, unknown>> => {
  const entries = input.branchEntries;
  const live = entries.map((e) => toLiveMessage(e));
  const at = live.flatMap((m, i) => (m ? [i] : []));
  const restored = restoreOriginals(at.map((i) => live[i]), at.map((i) => entries[i]?.id), input.sessionFile);
  const restoredAt = new Map(at.map((i, k) => [i, restored[k]]));
  return entries.map((e, i) => {
    const m = live[i];
    const original = restoredAt.get(i);
    return {
      ...(typeof e?.id === "string" && input.indexById?.has(e.id) ? { n: input.indexById.get(e.id) } : {}),
      ...(m ? { summary: toSummaryMessage(m, input.convert) ?? null } : {}),
      ...(m && original !== m ? { restored: toSummaryMessage(original, input.convert) ?? null } : {}),
    };
  });
};

/** The plan from the Lisp core, or undefined when there is none or it leaves this one to TypeScript. */
export const planInCore = (input: PlanInput): Plan | undefined => {
  const { convert: _convert, indexById: _indexById, branchEntries: _branch, rule, ...rest } = input;
  const reply = callCore({ op: "compact", input: { ...rest, ruleName: rule.name, branch: input.branchEntries, notes: hostNotes(input) } });
  return reply?.plan as Plan | undefined;
};

export const planCompaction = (input: PlanInput): Plan => {
  const inCore = planInCore(input);
  if (inCore) return inCore;
  const sizing = sizeCompaction(input);
  return { ...planSized(input, sizing), sizing } as Plan;
};

type Unsized<T> = T extends unknown ? Omit<T, "sizing"> : never;

const planSized = (input: PlanInput, sizing: Sizing): Unsized<Plan> => {
  const { branchEntries, convert, settings, recovering } = input;
  const { budgets, policy, trigger } = sizing;
  const charsPerToken = sizing.tokenEstimate.charsPerToken;
  // A pass omp-vcc started itself went by the policy as last recorded; this one
  // carries the current policy, which may since say no: compaction off, or a
  // trigger the context (measured as the end-of-run check measured it) is under.
  if (input.selfStarted) {
    const used = input.selfStarted.usedTokens;
    if (!input.rule.autoCompacts(policy) || (typeof used === "number" && trigger !== undefined && used < trigger)) return { kind: "cancel", why: "policy" };
  }
  const cutOptions = { charsPerToken, skipCustomTypes: settings.skipCustomTypes, maxTokens: budgets.maxTailTokens };

  // Smart keep-tail: boost default keep when the tail is small.
  // Explicit keep:N from the user is always respected (resolver no-ops).
  const smartKeep = resolveSmartKeepUserTurns({
    branchEntries,
    requestedKeepUserTurns: input.keepUserTurns,
    smartKeepTail: settings.smartKeepTail,
    skipCustomTypes: settings.skipCustomTypes,
    charsPerToken,
    minTokens: budgets.minTailTokens,
    maxTokens: budgets.maxTailTokens,
    convert,
  });
  let ownCut: OwnCutResult = buildOwnCut(convert, branchEntries, smartKeep.keepUserTurns, settings.skipCustomTypes);
  // Default path only: rescue autonomous / oversized-tail sessions with a
  // token-budget cut. Explicit keep:N is respected absolutely (no-op here).
  if (ownCut.ok && input.keepUserTurns === null) ownCut = applyTailBudget(convert, branchEntries, ownCut, cutOptions);
  // An automatic pass on a turn still running (its last message is a tool
  // result: omp compacts between the tool calls of one turn) whose live window
  // has no earlier user turn and fits the tail budget: the only cut left is
  // compact-all, which would summarize away the request and tool output the
  // agent is working from. A threshold or idle pass waits until the turn has
  // ended; a recovery pass keeps the turn's newest steps and summarizes the rest.
  let runningTurnRecovery = false;
  if (
    ownCut.ok && ownCut.compactAll && ownCut.keepFallbackToCompactAll && !input.fromCommand
    && ownCut.messages[ownCut.messages.length - 1]?.role === "toolResult"
    && input.reason !== "manual"
  ) {
    if (!recovering) return { kind: "cancel", why: "running_turn", summarized: ownCut.messages.length };
    ownCut = runningTurnCut(convert, branchEntries, cutOptions) ?? ownCut;
    runningTurnRecovery = true;
  }
  // One or two messages too big for the window: summarized whole on a recovery pass.
  if (!ownCut.ok && recovering && ownCut.reason === "too_few_live_messages") {
    ownCut = wholeWindowCut(convert, branchEntries, settings.skipCustomTypes) ?? ownCut;
  }
  if (!ownCut.ok) {
    // Nothing live to summarize: no method of the host's can shrink it either, so a recovery pass is left to it.
    if (recovering) return { kind: "step_aside", cutReason: ownCut.reason, liveRoles: liveRoles(branchEntries) };
    return { kind: "cancel", why: "no_cut", notice: CUT_CANCEL_NOTICES[ownCut.reason], cutReason: ownCut.reason, liveRoles: liveRoles(branchEntries) };
  }

  const assembled = assembleSummary({
    branchEntries,
    cut: ownCut,
    convert,
    sessionFile: input.sessionFile,
    indexById: input.indexById,
    previousSummary: input.previousSummary,
    fileOps: input.fileOps,
    settings,
    budgets,
    charsPerToken,
  });
  const { compiled, growth } = assembled;

  // Growth guard: a compaction that leaves the context bigger is not written,
  // and a manual pass says why (an automatic one would say so on every turn
  // until the prefix grows). Recovering, it is written when it keeps part of
  // the window: what overflows is that kept part, and omp's rescue shakes its
  // oversized tool output once this commits. When even summarizing the whole
  // window grows the context, what fills it is what no compaction removes.
  if (growth.grows && (!recovering || ownCut.compactAll)) {
    const n = ownCut.messages.length;
    const notice = recovering
      ? `omp-vcc: Not compacted: the ${n} messages left are smaller than a summary of them; the context is full of what no compaction removes (the system prompt and tools).`
      : input.reason === "manual"
        ? `omp-vcc: Not compacted: the summary would be ${growth.netChars} chars larger than the ${n} messages it replaces.${ownCut.compactAll ? "" : " keep:0 summarizes everything."}`
        : undefined;
    return { kind: "cancel", why: "growth", ...(notice ? { notice } : {}), growth, summarized: n };
  }

  const keptIdx = branchEntries.findIndex((e: any) => e.id === ownCut.firstKeptEntryId);
  const kept = keptIdx >= 0 ? branchEntries.slice(keptIdx) : [];
  return {
    kind: "compact",
    summary: compiled.text,
    firstKeptEntryId: ownCut.firstKeptEntryId,
    sections: compiled.sections,
    summaryState: compiled.state,
    summarized: assembled.summarized,
    ...(assembled.historyIndex ? { historyIndex: assembled.historyIndex } : {}),
    ...(assembled.workingSet ? { workingSet: assembled.workingSet } : {}),
    stats: {
      summarized: assembled.summarized,
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      keptTokensEst: estimateTokensFromChars(keptChars(kept), charsPerToken),
      smartKeepAdjusted: smartKeep.smartAdjusted,
      ...(ownCut.budgetCut ? { budgetCut: ownCut.budgetCut } : {}),
    },
    ...(ownCut.budgetCut ? { budgetCut: ownCut.budgetCut } : {}),
    compactAll: ownCut.compactAll,
    ...(growth.grows ? { writtenForRescue: { growth, summarized: ownCut.messages.length } } : {}),
    ...(runningTurnRecovery ? { runningTurnRecovery } : {}),
  };
};
