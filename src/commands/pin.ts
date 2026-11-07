// /omp-vcc-pin and /omp-vcc-unpin (/pi-vcc-pin and /pi-vcc-unpin on Pi).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { PIN_NOTICE_TYPE } from "../names";
import { pinInCore, type PinAnswer } from "../core/pins";
import { tell, type HostProfile } from "../host";
import { whenCore } from "../core/core-wait";

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
  /** What the core makes of the command's text (lisp/src/pins.lisp), told; while the core is not there, why. */
  const run = (name: "pin" | "unpin") => async (args: string, ctx: any) => {
    const result = whenCore(() => pinInCore(pi, ctx.sessionManager, { surface: "command", name, args }), (why) => tell(ctx, why, "warning"));
    if (result) answer(pi, ctx, result);
  };
  pi.registerCommand(`${host.command}-pin`, {
    description: "Pin a note that stays at the top of every omp-vcc summary. No text lists the pinned notes.",
    handler: run("pin"),
  });
  pi.registerCommand(`${host.command}-unpin`, {
    description: "Unpin an omp-vcc note by its [N].",
    handler: run("unpin"),
  });
};
