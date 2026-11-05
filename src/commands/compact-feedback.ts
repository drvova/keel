// What omp-vcc's commands tell the user, and what /omp-vcc says once a
// compaction it asked for ends.
import { formatCompactionStats, scheduleCompactionStatsNotify, type CompactionStats } from "../hooks/compaction";

export interface NotifyCtx {
  /** False in omp's print and json modes, whose extension UI drops notify. */
  hasUI?: boolean;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
  sessionManager?: { getBranch?: () => Array<{ type?: string }> };
}

/** The branch has a compaction still in effect (none, or one before omp's /clear, does not count). */
const compactedBefore = (ctx: NotifyCtx): boolean => {
  let branch: Array<{ type?: string }> = [];
  try {
    branch = ctx.sessionManager?.getBranch?.() ?? [];
  } catch {}
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.type === "compaction") return true;
    if (branch[i]?.type === "reset_boundary") return false;
  }
  return false;
};

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

/**
 * Why a compaction /omp-vcc asked for did not happen. `cancelNotice` is the
 * hook's own reason when it cancelled; where there is a UI it was shown already.
 */
export const reportCompactError = (ctx: NotifyCtx, err: Error, cancelNotice?: string | null, hostName: "omp" | "Pi" = "omp"): void => {
  if (err.message === "Compaction cancelled" && cancelNotice) {
    if (ctx.hasUI === false) tell(ctx, cancelNotice, "warning");
  } else if (err.message === "Already compacted") {
    tell(ctx, "Nothing to compact: the session was just compacted.", "warning");
  } else if (err.message === "Compaction cancelled") {
    tell(ctx, "Nothing to compact", "warning");
  } else if (err.message.startsWith("Nothing to compact")) {
    // omp and Pi throw this before any extension hook runs: everything since the
    // last compaction (or the start) still fits in the recent part the host always
    // keeps (compaction.keepRecentTokens in either's settings).
    tell(
      ctx,
      compactedBefore(ctx)
        ? `Nothing to compact yet: what came after the last compaction still fits in the recent part ${hostName} always keeps ` +
            `(compaction.keepRecentTokens in ${hostName} settings). Try again after a few more turns.`
        : `Nothing to compact yet: the whole session still fits in the recent part ${hostName} always keeps ` +
            `(compaction.keepRecentTokens in ${hostName} settings). Try again once the session is longer.`,
      "warning",
    );
  } else {
    tell(ctx, `Compaction failed: ${err.message}`, "error");
  }
};
