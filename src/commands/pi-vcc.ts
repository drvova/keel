import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLastCompactionStats } from "../hooks/before-compact";
import { buildPiVccCustomInstructions, parseKeepAndPrompt } from "../core/compact-args";
import { reportCompactDone, reportCompactError } from "./compact-feedback";

export const registerPiVccCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-vcc", {
    description: "Compact conversation with pi-vcc structured summary",
    handler: async (args: string, ctx) => {
      const { followUpPrompt, keepUserTurns } = parseKeepAndPrompt(args);
      ctx.compact({
        customInstructions: buildPiVccCustomInstructions(keepUserTurns),
        onComplete: () => reportCompactDone(ctx, getLastCompactionStats(), followUpPrompt, (c) => pi.sendUserMessage(c)),
        onError: (err) => reportCompactError(ctx, err, "Pi"),
      });
    },
  });
};
