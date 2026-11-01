// omp-vcc: algorithmic compaction and recall for omp (oh-my-pi). omp binds this
// factory once per session, subagents included, while module state is shared,
// so everything per-session lives in what it creates here.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { scaffoldSettings, setSettingsAgentDir } from "./src/core/settings";
import { createCompactionState, registerCompactionHook } from "./src/hooks/compaction";
import { createOmpCompactionHost, trackOmpCompactionTrigger } from "./src/hooks/omp-host";
import { registerWindowTracking } from "./src/hooks/window-limits";
import { registerOmpSettings } from "./src/hooks/omp-settings";
import { registerOmpVccCommand } from "./src/commands/omp-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerPinCommands } from "./src/commands/pin";
import { registerRecallTool } from "./src/tools/recall";
import { registerPinTool } from "./src/tools/pin";

export default (pi: ExtensionAPI) => {
  setSettingsAgentDir(() => pi.pi.getAgentDir());
  scaffoldSettings();
  const state = createCompactionState();
  const host = createOmpCompactionHost(pi, trackOmpCompactionTrigger(pi));
  registerCompactionHook(pi, host, state);
  registerWindowTracking(pi, state);
  registerOmpSettings(pi);
  registerOmpVccCommand(pi, state);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
  registerPinTool(pi);
  registerPinCommands(pi);
};
