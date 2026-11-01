// /pi-vcc-pin and /pi-vcc-unpin, for both hosts (their command APIs match here).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addPin, listPins, removePin } from "../tools/pin-spec";

/** Tell the agent too, without starting a turn: on its next request it sees what was pinned. */
const noteForAgent = (pi: ExtensionAPI, content: string) => {
  try {
    void Promise.resolve(pi.sendMessage({ customType: "pi-vcc-pin", content, display: true }, { deliverAs: "nextTurn" })).catch(() => {});
  } catch {}
};

export const registerPinCommands = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-vcc-pin", {
    description: "Pin a note that stays at the top of every pi-vcc summary. No text lists the pinned notes.",
    handler: async (args: string, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify(listPins(ctx.sessionManager), "info");
        return;
      }
      const result = addPin(pi, ctx.sessionManager, args, "user");
      ctx.ui.notify(result, result.startsWith("Pinned") ? "info" : "warning");
      if (result.startsWith("Pinned")) noteForAgent(pi, `The user ${result.charAt(0).toLowerCase()}${result.slice(1)} It stays at the top of every summary.`);
    },
  });

  pi.registerCommand("pi-vcc-unpin", {
    description: "Unpin a pi-vcc note by its [N].",
    handler: async (args: string, ctx) => {
      const result = removePin(pi, ctx.sessionManager, args.trim());
      ctx.ui.notify(result, result.startsWith("Unpinned") ? "info" : "warning");
      if (result.startsWith("Unpinned")) noteForAgent(pi, `The user ${result.charAt(0).toLowerCase()}${result.slice(1)} It no longer holds.`);
    },
  });
};
