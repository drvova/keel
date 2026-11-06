// The line a compaction's outcome is told in, and the toast that shows it:
// read by the hook (automatic and /compact passes) and /omp-vcc's feedback.
import type { CompactionReason } from "../types";
import type { BudgetCutKind } from "./cut";

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
