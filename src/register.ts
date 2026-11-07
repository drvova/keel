// Everything omp-vcc registers on a host, the same on omp and on Pi. Each
// binding gets its own state: omp binds the factory again for every subagent
// session while module state is shared.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { bind, type Host } from "./host";
import { openConfig } from "./core/settings";
import { createCompactionState, registerCompactionHook } from "./hooks/compaction";
import { createWindowState, registerWindowTracking } from "./hooks/window-limits";
import { registerRawCapture } from "./hooks/raw-capture";
import { registerOmpVccCommand } from "./commands/omp-vcc";
import { registerVccRecallCommand } from "./commands/vcc-recall";
import { registerPinCommands } from "./commands/pin";
import { registerRecallTool } from "./tools/recall";
import { registerPinTool } from "./tools/pin";
import { coreStatus } from "./core/lisp-core";
import { registerEviction } from "./hooks/eviction";
import { registerContextTool } from "./tools/context";
import { registerEvictCommand } from "./commands/evict";

export const register = (pi: ExtensionAPI, host: Host): void => {
  // The core is built with the user's SBCL the first time this copy runs (lisp-core.ts): start it now.
  coreStatus();
  const binding = bind(host, openConfig(host.agentDir));
  binding.config.scaffold();
  const state = createCompactionState();
  const windows = createWindowState();
  registerCompactionHook(pi, binding, state, windows);
  registerWindowTracking(pi, windows, binding);
  if (binding.rewritesInPlace) registerRawCapture(pi, binding);
  registerOmpVccCommand(pi, state, binding);
  registerVccRecallCommand(pi, binding);
  registerRecallTool(pi, binding);
  registerPinTool(pi, binding);
  registerPinCommands(pi, binding);
  // Old turns out of the context whole, instead of a summary, with the evict setting on.
  registerEviction(pi, binding);
  if (binding.config.load().evict) registerContextTool(pi, binding);
  registerEvictCommand(pi, binding);
};
