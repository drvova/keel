// /omp-vcc-evict (/pi-vcc-evict on Pi): the user takes old turns out of the
// context whole. No text takes out the oldest half; a number that many of the
// oldest turns; all every finished turn; #A-#B a range; restore #A-#B (or
// restore all) brings turns back; list shows what is in and out.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { tell, type Binding } from "../host";
import { whenCore } from "../core/core-wait";
import { evict } from "../core/evict";

export const registerEvictCommand = (pi: ExtensionAPI, host: Binding) => {
  pi.registerCommand(`${host.command}-evict`, {
    description: "Take old turns out of the context whole (no text: the oldest half; N, all, #A-#B, restore #A-#B, list).",
    handler: async (args: string, ctx: any) => {
      const text = whenCore(() => evict(pi, host, ctx, { surface: "command", args }), (why) => tell(ctx, why, "warning"));
      if (text) tell(ctx, text, "info");
    },
  });
};
