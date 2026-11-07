// /keel-pin and /keel-unpin (also under their old names, /omp-vcc-… on omp and /pi-vcc-… on Pi).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { PIN_NOTICE_TYPE } from "../names";
import { pin, type PinAnswer } from "../core/pins";
import { deliver, registerCommand, tell, type Binding } from "../host";
import { whenCore } from "../core/core-wait";

/** The core's answer to a pin command, told; the agent hears it too, without a turn: on its next request it sees what was pinned. */
const answer = (pi: ExtensionAPI, ctx: any, result: PinAnswer) => {
  tell(ctx, result.text, result.severity);
  const note = result.agentNote;
  if (note) void deliver(ctx, "the pin to the agent", () => pi.sendMessage({ customType: PIN_NOTICE_TYPE, content: note, display: true }, { deliverAs: "nextTurn" }));
};

export const registerPinCommands = (pi: ExtensionAPI, host: Binding) => {
  /** What the core makes of the command's text (lisp/src/pins.lisp), told; while the core is not there, why. */
  const run = (name: "pin" | "unpin") => async (args: string, ctx: any) => {
    const result = whenCore(() => pin(pi, host, ctx, { surface: "command", name, args }), (why) => tell(ctx, why, "warning"));
    if (result) answer(pi, ctx, result);
  };
  registerCommand(pi, host, "pin", {
    description: "Pin a note that stays at the top of every keel summary; name:NAME first names it, and a name pinned again is replaced. No text lists the pinned notes.",
    handler: run("pin"),
  });
  registerCommand(pi, host, "unpin", {
    description: "Unpin a keel note by its [N] or its name.",
    handler: run("unpin"),
  });
};
