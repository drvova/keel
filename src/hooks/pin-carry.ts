// A session starting carries the named notes of the project's last session
// (src/core/pins.ts carryPins): the user is told what came over.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { carryPins } from "../core/pins";
import { whenCore } from "../core/core-wait";
import { tell, type Binding } from "../host";

export const registerPinCarry = (pi: ExtensionAPI, host: Binding) => {
  pi.on("session_start", (_event, ctx) => {
    const text = whenCore(() => carryPins(pi, host, ctx as any));
    if (text) tell(ctx, `omp-vcc: ${text}`, "info");
  });
};
