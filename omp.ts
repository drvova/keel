// omp (oh-my-pi) entry point: package.json "omp.extensions", which omp prefers
// over "pi.extensions". Native: everything host-specific comes from omp's own
// extension API (`pi.pi` is omp's package), with no import of either host package.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldSettings, setSettingsAgentDir } from "./src/core/settings";
import { createCompactionState, registerCompactionHook } from "./src/hooks/compaction";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import type { OmpExtensionAPI } from "./src/omp/api";
import { createOmpCompactionHost, trackOmpCompactionTrigger } from "./src/omp/host";
import { registerOmpPiVccCommand } from "./src/omp/commands";
import { registerOmpRecallTool } from "./src/omp/recall-tool";

export default (pi: OmpExtensionAPI) => {
  setSettingsAgentDir(() => pi.pi.getAgentDir());
  scaffoldSettings();

  // omp binds this factory again for each subagent session while module state is
  // shared, so the hook's state, and its host, live in this binding.
  const state = createCompactionState();
  const host = createOmpCompactionHost(pi, trackOmpCompactionTrigger(pi));

  // The session_before_compact / session_compact payloads and the command
  // context used by /pi-vcc-recall have the same shape on omp as on Pi.
  const piShaped = pi as unknown as ExtensionAPI;
  registerCompactionHook(piShaped, host, state);
  registerOmpPiVccCommand(pi, state);
  registerVccRecallCommand(piShaped);
  registerOmpRecallTool(pi);
};
