// /omp-vcc-pin and /omp-vcc-unpin (/pi-vcc-pin and /pi-vcc-unpin on Pi).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { HostProfile } from "../host";
import { PIN_NOTICE_TYPE } from "../names";
import { addPin, listPins, removePin } from "../tools/pin";
import { tell } from "./compact-feedback";

/** Tell the agent too, without starting a turn: on its next request it sees what was pinned. */
const noteForAgent = (pi: ExtensionAPI, content: string) => {
  try {
    void Promise.resolve(pi.sendMessage({ customType: PIN_NOTICE_TYPE, content, display: true }, { deliverAs: "nextTurn" })).catch(() => {});
  } catch {}
};

export const registerPinCommands = (pi: ExtensionAPI, host: HostProfile) => {
  pi.registerCommand(`${host.command}-pin`, {
    description: "Pin a note that stays at the top of every omp-vcc summary. No text lists the pinned notes.",
    handler: async (args: string, ctx) => {
      if (!args.trim()) {
        tell(ctx, listPins(ctx.sessionManager));
        return;
      }
      const result = addPin(pi, ctx.sessionManager, args, "user");
      tell(ctx, result, result.startsWith("Pinned") ? "info" : "warning");
      if (result.startsWith("Pinned")) noteForAgent(pi, `The user ${result.charAt(0).toLowerCase()}${result.slice(1)} It stays at the top of every summary.`);
    },
  });

  pi.registerCommand(`${host.command}-unpin`, {
    description: "Unpin an omp-vcc note by its [N].",
    handler: async (args: string, ctx) => {
      const result = removePin(pi, ctx.sessionManager, args.trim());
      tell(ctx, result, result.startsWith("Unpinned") ? "info" : "warning");
      if (result.startsWith("Unpinned")) noteForAgent(pi, `The user ${result.charAt(0).toLowerCase()}${result.slice(1)} It no longer holds.`);
    },
  });
};
