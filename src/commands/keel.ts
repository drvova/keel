// /keel (also under its old name, /omp-vcc on omp and /pi-vcc on Pi).
//
// omp's ctx.compact() takes a focus string or an options object, not both, and
// its options have no customInstructions. A string alone is not enough: the TUI
// reports a failed compaction itself and resolves anyway, so only onComplete /
// onError say how it ended. So the options object goes to ctx.compact(), and the
// keel marker reaches the hook through this binding's state for the manual
// pass that call starts.
//
// Pi's ctx.compact() takes the options object with customInstructions, which
// reach the hook, and returns before the compaction runs: only onComplete /
// onError say it ended. So the marker goes both ways, and the command waits for
// whichever the host settles by (omp: the call's promise; Pi: the callbacks)
// before it clears the state.
import { commandArgs } from "../core/compact-args";
import type { CompactionState } from "../hooks/compaction";
import { reportCompactDone, reportCompactError } from "./compact-feedback";
import { compactAndWait, registerCommand, tell, type Binding } from "../host";
import { whenCore } from "../core/core-wait";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const registerKeelCommand = (pi: ExtensionAPI, state: CompactionState, host: Binding) => {
  registerCommand(pi, host, "", {
    description: "Compact the conversation into a keel structured summary (keep:N keeps the last N user turns)",
    handler: async (args, ctx) => {
      const parsed = whenCore(() => commandArgs(args), (why) => tell(ctx, why, "warning"));
      if (!parsed) return;
      const { followUpPrompt, instructions } = parsed;
      state.lastCancelNotice = null;
      state.pendingManualInstructions = instructions;
      try {
        await compactAndWait(ctx as any, {
          customInstructions: instructions,
          // A follow-up prompt replaces omp's resume of a turn the compaction interrupted.
          ...(followUpPrompt ? { suppressContinuation: true } : {}),
          onComplete: () => {
            // The compaction this pass wrote, which the hook keeps for the command to tell.
            const written = state.written?.fromCommand ? state.written : null;
            reportCompactDone(ctx, written?.statsLine ?? null, followUpPrompt, (content) => pi.sendUserMessage(content));
          },
          onError: (err: Error) => reportCompactError(host, ctx as any, err, state.lastCancelNotice),
        });
      } catch {
        // A compact() that throws has reported through onError.
      } finally {
        state.pendingManualInstructions = null;
      }
    },
  });
};
