// What omp-vcc's commands tell the user, and what /omp-vcc says once a
// compaction it asked for ends.
import { hostBranch } from "../core/session-file";
import { tell, type HostProfile, type NotifyCtx } from "../host";
import { tellCompactionStats, type CompactionStats } from "../compaction/stats";
import { core } from "../core/lisp-core";

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
  // The core decides what is told (lisp/src/outcome.lisp, op outcome); a branch with a compaction in effect says "after the last compaction".
  const reply = core({ op: "outcome", error: {
    message: err.message, mode: ctx.mode ?? null, cancelNotice: cancelNotice ?? null, hostName,
    branch: (hostBranch(ctx.sessionManager) ?? []).map((e: any) => ({ type: e?.type })),
  } });
  if (typeof reply.text === "string") tell(ctx, reply.text, reply.severity as "warning" | "error");
};
