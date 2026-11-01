// What omp-vcc's commands tell the user, and what /omp-vcc says once a
// compaction it asked for ends.
import { formatCompactionStats, scheduleCompactionStatsNotify, type CompactionStats } from "../hooks/compaction";

export interface NotifyCtx {
  /** False in omp's print and json modes, whose extension UI drops notify. */
  hasUI?: boolean;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

/**
 * Tell the user: omp's notify where there is a UI. Print and json modes have
 * none (their notify is a no-op), so there it goes to stderr, as omp's own
 * commands' output does, and stdout stays the model's.
 */
export const tell = (ctx: NotifyCtx, message: string, type: "info" | "warning" | "error" = "info"): void => {
  if (ctx.hasUI === false) {
    try {
      process.stderr.write(`${message}\n`);
    } catch {}
    return;
  }
  ctx.ui.notify(message, type);
};

export const reportCompactDone = (
  ctx: NotifyCtx,
  stats: CompactionStats | null,
  followUpPrompt: string,
  sendUserMessage: (content: string) => unknown,
): void => {
  if (stats && ctx.hasUI === false) tell(ctx, formatCompactionStats(stats));
  else if (stats) scheduleCompactionStatsNotify(ctx, stats);
  else tell(ctx, "Compacted with omp-vcc");
  if (followUpPrompt) {
    try {
      void Promise.resolve(sendUserMessage(followUpPrompt)).catch(() => {});
    } catch {}
  }
};

export const reportCompactError = (ctx: NotifyCtx, err: Error): void => {
  if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
    tell(ctx, "Nothing to compact", "warning");
  } else if (err.message.startsWith("Nothing to compact")) {
    // omp throws this before any extension hook runs: everything still fits in
    // the recent part it always keeps (compaction.keepRecentTokens).
    tell(
      ctx,
      "Nothing to compact yet: the whole session still fits in the recent part omp always keeps " +
        "(compaction.keepRecentTokens in omp settings). Try again once the session is longer.",
      "warning",
    );
  } else {
    tell(ctx, `Compaction failed: ${err.message}`, "error");
  }
};
