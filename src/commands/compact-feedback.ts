// What /omp-vcc tells the user once a compaction it asked for ends.
import { scheduleCompactionStatsNotify, type CompactionStats } from "../hooks/compaction";

interface NotifyCtx {
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

export const reportCompactDone = (
  ctx: NotifyCtx,
  stats: CompactionStats | null,
  followUpPrompt: string,
  sendUserMessage: (content: string) => unknown,
): void => {
  if (stats) {
    scheduleCompactionStatsNotify(ctx, stats);
  } else {
    ctx.ui.notify("Compacted with omp-vcc", "info");
  }
  if (followUpPrompt) {
    try {
      void Promise.resolve(sendUserMessage(followUpPrompt)).catch(() => {});
    } catch {}
  }
};

export const reportCompactError = (ctx: NotifyCtx, err: Error): void => {
  if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
    ctx.ui.notify("Nothing to compact", "warning");
  } else if (err.message.startsWith("Nothing to compact")) {
    // omp throws this before any extension hook runs: everything still fits in
    // the recent part it always keeps (compaction.keepRecentTokens).
    ctx.ui.notify(
      "Nothing to compact yet: the whole session still fits in the recent part omp always keeps " +
        "(compaction.keepRecentTokens in omp settings). Try again once the session is longer.",
      "warning",
    );
  } else {
    ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
  }
};
