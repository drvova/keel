// What a compaction does: what it is sized for (the host's trigger under its
// policy, the context's overhead and chars per token, the budgets), where it
// cuts (smart keep-tail, the cut, its token-budget rescues, a running turn's
// newest steps, the whole window), what it writes and whether that is worth
// writing (the growth guard). The core decides all of it (lisp/src/compaction.lisp,
// op compact); what it cannot do is the host's convertToLlm, which this applies
// to each entry before asking (hostNotes). The hook (src/hooks/compaction.ts)
// acts on the plan.
import type { FileOps, CompactionReason } from "../types";
import type { CompactionBudgets, TriggerRule } from "../core/window";
import type { VccSettings } from "../core/settings";
import type { ConvertToLlm } from "../host";
import { toLiveMessage, toSummaryMessage } from "./summary-input";
import { restoreOriginals } from "../core/raw-store";
import { projectContextEdits } from "../core/context-edits";
import { core } from "../core/lisp-core";
import type { CompactionStats } from "./stats";
import type { VccCompactionDetails } from "../details";

export interface PlanInput {
  /** The branch as the host has it; the plan reads it as the context holds it (Pi's context edits applied). */
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
  /** The effective context window, when one is known, and where it came from (model-limits.ts windowOf). */
  window: number | undefined;
  windowSource?: string;
  /** The host retries the turn once this lands (details.willRetry). */
  willRetry?: boolean;
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

/** Why there is no cut: nothing live, or too little to compact. */
export type OwnCutCancelReason = "no_live_messages" | "too_few_live_messages";

/** What a compaction was sized from: the host's policy, its trigger, the context's overhead and chars per token, the budgets. */
export interface Sizing {
  policy: object | undefined;
  trigger: number | undefined;
  overheadTokens: number;
  /** Chars per token, calibrated on the messages where the host counted the context (lisp/src/window.lisp calibrate-chars-per-token). */
  tokenEstimate: { mode: "heuristic" | "calibrated"; charsPerToken: number; sourceChars?: number; sourceTokens?: number; rawCharsPerToken?: number };
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
      /** What the compaction entry stores (details.ts). */
      details: VccCompactionDetails;
    }
) & { sizing: Sizing };

/**
 * What the Lisp core needs of the host for each branch entry: its #N, and what
 * convertToLlm makes of its live message for the summary (toSummaryMessage), as
 * it is and, where omp rewrote it, as the original omp-vcc kept. The core does
 * the rest (lisp/src/compaction.lisp).
 */
export const hostNotes = (input: Pick<PlanInput, "branchEntries" | "convert" | "sessionFile" | "indexById">): Array<Record<string, unknown>> => {
  // Of each entry as the context holds it: the core drops what Pi's edits omit, and reads its replacements, itself.
  const raw = input.branchEntries;
  const entries = projectContextEdits(raw) ?? raw;
  const live = entries.map((e) => (e ? toLiveMessage(e) : undefined));
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

/** The compaction's plan, from the core. */
export const planCompaction = (input: PlanInput): Plan => {
  const { convert: _convert, indexById: _indexById, branchEntries: _branch, rule, ...rest } = input;
  return core({ op: "compact", input: { ...rest, ruleName: rule.name, branch: input.branchEntries, notes: hostNotes(input) } }).plan as Plan;
};
