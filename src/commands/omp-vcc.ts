// /omp-vcc (/pi-vcc on Pi).
//
// omp's ctx.compact() takes a focus string or an options object, not both, and
// its options have no customInstructions. A string alone is not enough: the TUI
// reports a failed compaction itself and resolves anyway, so only onComplete /
// onError say how it ended. So the options object goes to ctx.compact(), and the
// omp-vcc marker reaches the hook through this binding's state for the manual
// pass that call starts.
//
// Pi's ctx.compact() takes the options object with customInstructions, which
// reach the hook, and returns before the compaction runs: only onComplete /
// onError say it ended. So the marker goes both ways, and the command waits for
// whichever the host settles by (omp: the call's promise; Pi: the callbacks)
// before it clears the state.
import { buildVccCustomInstructions, parseKeepAndPrompt } from "../core/compact-args";
import type { CompactionState } from "../hooks/compaction";
import { reportCompactDone, reportCompactError } from "../commands/compact-feedback";
import { OMP_HOST, type HostProfile } from "../host";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const registerOmpVccCommand = (pi: ExtensionAPI, state: CompactionState, host: HostProfile = OMP_HOST) => {
  pi.registerCommand(host.command, {
    description: "Compact the conversation into an omp-vcc structured summary (keep:N keeps the last N user turns)",
    handler: async (args, ctx) => {
      const { followUpPrompt, keepUserTurns } = parseKeepAndPrompt(args);
      const instructions = buildVccCustomInstructions(keepUserTurns);
      state.lastStats = null;
      state.lastCancelNotice = null;
      state.pendingManualInstructions = instructions;
      try {
        await new Promise<void>((resolve) => {
          const returned: unknown = ctx.compact({
            customInstructions: instructions,
            // A follow-up prompt replaces omp's resume of a turn the compaction interrupted.
            ...(followUpPrompt ? { suppressContinuation: true } : {}),
            onComplete: () => {
              reportCompactDone(ctx, state.lastStats, followUpPrompt, (content) => pi.sendUserMessage(content));
              resolve();
            },
            onError: (err: Error) => {
              // The TUI already shows "Compaction cancelled" / "Compaction failed: …";
              // there omp-vcc adds only its hint for a session that is still too short.
              if (!(ctx.mode === "tui" && !err.message.startsWith("Nothing to compact"))) {
                reportCompactError(ctx, err, state.lastCancelNotice, host.displayName);
              }
              resolve();
            },
          } as Parameters<typeof ctx.compact>[0]);
          // omp settles the call with the compaction (its callbacks have run by then).
          if (returned && typeof (returned as Promise<unknown>).then === "function") {
            (returned as Promise<unknown>).then(() => resolve(), () => resolve());
          }
        });
      } catch {
        // Already reported through onError.
      } finally {
        state.pendingManualInstructions = null;
      }
    },
  });
};
