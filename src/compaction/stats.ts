// The line a compaction's outcome is told in, and the toast that shows it:
// read by the hook (automatic and /compact passes) and /omp-vcc's feedback.
import { tell, type NotifyCtx } from "../host";
import { core } from "../core/lisp-core";

/** What the outcome line says. */
export interface CompactionStats {
  summarized: number;
  keptUserTurns: number;
  totalUserTurns: number;
  /** Set when the tail came from a token-budget cut instead of a user-turn cut. */
  budgetCut?: "final_reply" | "running_turn" | "no_anchor" | "oversized_tail";
  keptTokensEst: number;
  /** True when smart-keep boosted the default keep beyond 1. */
  smartKeepAdjusted?: boolean;
}

/** The outcome line, as the core writes it (lisp/src/outcome.lisp, op outcome). */
export const formatCompactionStats = (stats: CompactionStats): string => core({ op: "outcome", stats }).line as string;

/** The hook returns before the host applies the compaction and shows its own status; the line comes after it. */
const AFTER_HOST_STATUS_MS = 500;

/** The outcome line: at once where there is no UI (stderr; print mode may exit before a timer), else after the host's status. */
export const tellCompactionStats = (ctx: NotifyCtx, stats: CompactionStats): void => {
  if (ctx.hasUI === false) return tell(ctx, formatCompactionStats(stats));
  setTimeout(() => {
    // The session may have ended or the UI gone by then.
    try { tell(ctx, formatCompactionStats(stats)); } catch {}
  }, AFTER_HOST_STATUS_MS);
};
