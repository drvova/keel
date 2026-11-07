// What /omp-vcc says once a compaction it asked for ends.
import { deliver, tell, tellLater, type NotifyCtx } from "../host";
import { core } from "../core/lisp-core";
import { hostSnapshot, type HostCtx } from "../core/host-snapshot";

/** The compaction's outcome line, then the prompt to send after it. */
export const reportCompactDone = (ctx: NotifyCtx, statsLine: string | null, followUpPrompt: string, sendUserMessage: (content: string) => unknown): void => {
  // Without a line of omp-vcc's own (another extension's compaction won), the compaction still happened.
  if (statsLine) tellLater(ctx, statsLine);
  else tell(ctx, "Compacted with omp-vcc");
  if (followUpPrompt) void deliver(ctx, "the follow-up prompt", () => sendUserMessage(followUpPrompt));
};

/**
 * Why a compaction /omp-vcc asked for did not happen, from the host's error.
 * `cancelNotice` is the hook's own reason when it cancelled, which it told
 * already. omp's TUI shows its own "Compaction cancelled" / "Compaction
 * failed: …", so there only the hint for a session still too short is added.
 */
export const reportCompactError = (
  host: Parameters<typeof hostSnapshot>[0],
  ctx: NotifyCtx & HostCtx & { mode?: string },
  err: Error,
  cancelNotice: string | null,
): void => {
  // The core decides what is told (lisp/src/outcome.lisp); a branch with a compaction in effect says "after the last compaction".
  const reply = core({ op: "outcome", host: hostSnapshot(host, ctx), error: { message: err.message, mode: ctx.mode ?? null, cancelNotice } });
  if (typeof reply.text === "string") tell(ctx, reply.text, reply.severity as "warning" | "error");
};
