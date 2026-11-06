// The line a compaction's outcome is told in, and the toast that shows it:
// read by the hook (automatic and /compact passes) and /omp-vcc's feedback.
import type { BudgetCutKind } from "./cut";

/** What the outcome line says. */
export interface CompactionStats {
  summarized: number;
  keptUserTurns: number;
  totalUserTurns: number;
  /** Set when the tail came from a token-budget cut instead of a user-turn cut. */
  budgetCut?: BudgetCutKind;
  keptTokensEst: number;
  /** True when smart-keep boosted the default keep beyond 1. */
  smartKeepAdjusted?: boolean;
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

/** The hook returns before the host applies the compaction and shows its own status; the line comes after it. */
const AFTER_HOST_STATUS_MS = 500;

export const scheduleCompactionStatsNotify = (ctx: any, stats: CompactionStats) => {
  setTimeout(() => {
    // The session may have ended or the UI gone by then.
    try { ctx?.ui?.notify?.(formatCompactionStats(stats), "info"); } catch {}
  }, AFTER_HOST_STATUS_MS);
};
