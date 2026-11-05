// omp-vcc on Pi (package.json "pi.extensions"; omp loads index.ts from
// "omp.extensions" instead). Pi binds this factory once per session runtime.
//
// The code is Pi's API: Pi hands extensions its own package, so convertToLlm and
// getAgentDir are imported from @earendil-works/pi-coding-agent, which Pi's
// loader resolves to the running Pi (its virtual modules), never to a copy.
// That import is the only one here; everything under src/ imports no host.
//
// Pi's event, tool and command shapes are the ones omp inherited from it, so the
// shared modules (typed against omp's API) take Pi's binding as they are; what
// differs arrives through the host: Pi's trigger rule (its window less
// reserveTokens), the trigger its session_before_compact carries, agent_settled,
// and the /pi-vcc command names. Pi rewrites nothing in place (its context edits
// are entries of their own, applied in core/context-edits.ts), so there are no
// originals to keep and no placeholders to point at: no raw capture.
import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { scaffoldSettings, setSettingsAgentDir } from "./src/core/settings";
import { createCompactionState, registerCompactionHook, type CompactionHost, type CompactionTrigger } from "./src/hooks/compaction";
import { registerWindowTracking } from "./src/hooks/window-limits";
import { registerOmpVccCommand } from "./src/commands/omp-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerPinCommands } from "./src/commands/pin";
import { registerRecallTool } from "./src/tools/recall";
import { registerPinTool } from "./src/tools/pin";
import { PI_HOST } from "./src/host";

/** The trigger Pi's session_before_compact carries: manual /compact, its threshold, or overflow recovery. */
const piCompactionTrigger = (event: unknown): CompactionTrigger => {
  const { reason, willRetry } = (event ?? {}) as { reason?: unknown; willRetry?: unknown };
  return {
    reason: reason === "threshold" || reason === "overflow" ? reason : "manual",
    willRetry: willRetry === true,
  };
};

export default (piApi: PiExtensionAPI) => {
  setSettingsAgentDir(getAgentDir);
  scaffoldSettings();
  const pi = piApi as unknown as ExtensionAPI;
  const state = createCompactionState();
  const host: CompactionHost = {
    convertToLlm: (messages) => convertToLlm(messages) as any[],
    compactionTrigger: piCompactionTrigger,
    rule: PI_HOST.rule,
  };
  registerCompactionHook(pi, host, state);
  registerWindowTracking(pi, state, PI_HOST);
  registerOmpVccCommand(pi, state, PI_HOST);
  registerVccRecallCommand(pi, PI_HOST);
  registerRecallTool(pi);
  registerPinTool(pi);
  registerPinCommands(pi, PI_HOST);
};
