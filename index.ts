// Pi entry point (package.json "pi.extensions"). omp loads ./omp.ts instead.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { scaffoldSettings, setSettingsAgentDir } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerRecallTool } from "./src/tools/recall";

export default (pi: ExtensionAPI) => {
  setSettingsAgentDir(getAgentDir);
  scaffoldSettings();
  registerBeforeCompactHook(pi);
  registerPiVccCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};
