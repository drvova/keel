// Everything omp-vcc registers on a host, the same on omp and on Pi. Each
// binding gets its own state: omp binds the factory again for every subagent
// session while module state is shared.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Host } from "./host";
import { scaffoldSettings, setSettingsAgentDir } from "./core/settings";
import { createCompactionState, registerCompactionHook } from "./hooks/compaction";
import { registerWindowTracking } from "./hooks/window-limits";
import { registerRawCapture } from "./hooks/raw-capture";
import { registerOmpVccCommand } from "./commands/omp-vcc";
import { registerVccRecallCommand } from "./commands/vcc-recall";
import { registerPinCommands } from "./commands/pin";
import { registerRecallTool } from "./tools/recall";
import { registerPinTool } from "./tools/pin";

export const register = (pi: ExtensionAPI, host: Host): void => {
  setSettingsAgentDir(host.agentDir);
  scaffoldSettings();
  const state = createCompactionState();
  registerCompactionHook(pi, host, state);
  registerWindowTracking(pi, state, host);
  if (host.rewritesInPlace) registerRawCapture(pi);
  registerOmpVccCommand(pi, state, host);
  registerVccRecallCommand(pi, host);
  registerRecallTool(pi, host);
  registerPinTool(pi, host);
  registerPinCommands(pi, host);
};
