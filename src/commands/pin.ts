// /omp-vcc-pin and /omp-vcc-unpin (/pi-vcc-pin and /pi-vcc-unpin on Pi).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { PIN_NOTICE_TYPE } from "../names";
import { addPin, listPins, pinInCore, removePin, type PinAnswer } from "../core/pins";
import { tell, type HostProfile } from "../host";
import { whenCore } from "../core/core-wait";

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** Tell the agent too, without starting a turn: on its next request it sees what was pinned. */
const noteForAgent = (pi: ExtensionAPI, content: string) => {
  try {
    void Promise.resolve(pi.sendMessage({ customType: PIN_NOTICE_TYPE, content, display: true }, { deliverAs: "nextTurn" })).catch(() => {});
  } catch {}
};

/** The core's answer to a pin command, told as the command tells its own. */
const answer = (pi: ExtensionAPI, ctx: any, result: PinAnswer) => {
  if (result.severity) tell(ctx, result.text, result.severity);
  else tell(ctx, result.text);
  if (result.agentNote) noteForAgent(pi, result.agentNote);
};

export const registerPinCommands = (pi: ExtensionAPI, host: HostProfile) => {
  pi.registerCommand(`${host.command}-pin`, {
    description: "Pin a note that stays at the top of every omp-vcc summary. No text lists the pinned notes.",
    handler: async (args: string, ctx) => {
      let waiting = false;
      const inCore = whenCore(() => pinInCore(pi, ctx.sessionManager, { surface: "command", name: "pin", args }), (why) => { waiting = true; tell(ctx, why, "warning"); });
      if (waiting) return;
      if (inCore) return answer(pi, ctx, inCore);
      if (!args.trim()) {
        tell(ctx, listPins(ctx.sessionManager));
        return;
      }
      const result = addPin(pi, ctx.sessionManager, args, "user");
      tell(ctx, result.text, result.done ? "info" : "warning");
      if (result.done) noteForAgent(pi, `The user ${lowerFirst(result.text)} It stays at the top of every summary.`);
    },
  });

  pi.registerCommand(`${host.command}-unpin`, {
    description: "Unpin an omp-vcc note by its [N].",
    handler: async (args: string, ctx) => {
      let waiting = false;
      const inCore = whenCore(() => pinInCore(pi, ctx.sessionManager, { surface: "command", name: "unpin", args }), (why) => { waiting = true; tell(ctx, why, "warning"); });
      if (waiting) return;
      if (inCore) return answer(pi, ctx, inCore);
      const result = removePin(pi, ctx.sessionManager, args.trim());
      tell(ctx, result.text, result.done ? "info" : "warning");
      if (result.done) noteForAgent(pi, `The user ${lowerFirst(result.text)} It no longer holds.`);
    },
  });
};
