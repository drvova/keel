// /omp-vcc.
//
// omp's ctx.compact() takes a focus string or an options object, not both, and
// its options have no customInstructions. A string alone is not enough: the TUI
// reports a failed compaction itself and resolves anyway, so only onComplete /
// onError say how it ended. So the options object goes to ctx.compact(), and the
// omp-vcc marker reaches the hook through this binding's state for the manual
// pass that call starts.
import { buildVccCustomInstructions, parseKeepAndPrompt } from "../core/compact-args";
import type { CompactionState } from "../hooks/compaction";
import { reportCompactDone, reportCompactError } from "../commands/compact-feedback";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const registerOmpVccCommand = (pi: ExtensionAPI, state: CompactionState) => {
  pi.registerCommand("omp-vcc", {
    description: "Compact the conversation into an omp-vcc structured summary (keep:N keeps the last N user turns)",
    handler: async (args, ctx) => {
      const { followUpPrompt, keepUserTurns } = parseKeepAndPrompt(args);
      state.lastStats = null;
      state.pendingManualInstructions = buildVccCustomInstructions(keepUserTurns);
      try {
        await ctx.compact({
          // A follow-up prompt replaces omp's resume of a turn the compaction interrupted.
          ...(followUpPrompt ? { suppressContinuation: true } : {}),
          onComplete: () => reportCompactDone(ctx, state.lastStats, followUpPrompt, (content) => pi.sendUserMessage(content)),
          onError: (err: Error) => {
            // The TUI already shows "Compaction cancelled" / "Compaction failed: …";
            // there omp-vcc adds only its hint for a session that is still too short.
            if (ctx.mode === "tui" && !err.message.startsWith("Nothing to compact")) return;
            reportCompactError(ctx, err);
          },
        });
      } catch {
        // Already reported through onError.
      } finally {
        state.pendingManualInstructions = null;
      }
    },
  });
};
