// What omp-vcc's commands tell the user, and what /omp-vcc says once a
// compaction it asked for ends.
import { afterReset, hostBranch } from "../core/session-file";
import { tell, type HostProfile, type NotifyCtx } from "../host";
import { tellCompactionStats, type CompactionStats } from "../compaction/stats";

/** The branch has a compaction still in effect (none, or one before omp's /clear, does not count). */
const compactedBefore = (ctx: NotifyCtx): boolean =>
  afterReset(hostBranch(ctx.sessionManager) ?? []).some((e) => e?.type === "compaction");

export const reportCompactDone = (
  ctx: NotifyCtx,
  stats: CompactionStats | null,
  followUpPrompt: string,
  sendUserMessage: (content: string) => unknown,
): void => {
  if (stats) tellCompactionStats(ctx, stats);
  else tell(ctx, "Compacted with omp-vcc");
  if (followUpPrompt) {
    try {
      void Promise.resolve(sendUserMessage(followUpPrompt)).catch(() => {});
    } catch {}
  }
};

/**
 * Why a compaction /omp-vcc asked for did not happen, from the host's error.
 * `cancelNotice` is the hook's own reason when it cancelled, which it told
 * already. omp's TUI shows its own "Compaction cancelled" / "Compaction
 * failed: …", so there only the hint for a session still too short is added.
 */
export const reportCompactError = (ctx: NotifyCtx & { mode?: string }, err: Error, cancelNotice: string | null | undefined, hostName: HostProfile["displayName"]): void => {
  if (ctx.mode === "tui" && !err.message.startsWith("Nothing to compact")) return;
  if (err.message === "Compaction cancelled" && cancelNotice) {
    return;
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
