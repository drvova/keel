// What /pi-vcc tells the user once a compaction it asked for ends. Shared by the
// Pi and omp commands; `hostName` names the host in the "nothing yet" hint.
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
    ctx.ui.notify("Compacted with pi-vcc", "info");
  }
  if (followUpPrompt) {
    try {
      void Promise.resolve(sendUserMessage(followUpPrompt)).catch(() => {});
    } catch {}
  }
};

export const reportCompactError = (ctx: NotifyCtx, err: Error, hostName: string): void => {
  if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
    ctx.ui.notify("Nothing to compact", "warning");
  } else if (err.message.startsWith("Nothing to compact")) {
    // The host throws this before any extension hook runs: everything still fits in
    // the recent part it always keeps (compaction.keepRecentTokens).
    ctx.ui.notify(
      `Nothing to compact yet: the whole session still fits in the recent part ${hostName} always keeps ` +
        `(compaction.keepRecentTokens in ${hostName} settings). Try again once the session is longer.`,
      "warning",
    );
  } else {
    ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
  }
};
