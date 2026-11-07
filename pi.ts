// keel on Pi (package.json "pi.extensions"; omp loads index.ts from
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
// and the /pi-vcc names kept as aliases of /keel…. Pi rewrites nothing in place (its context edits
// are entries of their own, which the compaction plan applies), so there are no
// originals to keep and no placeholders to point at: no raw capture.
import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { register } from "./src/register";
import { PI_HOST, type CompactionTrigger } from "./src/host";

/** The trigger Pi's session_before_compact carries: manual /compact, its threshold, or overflow recovery. */
const piCompactionTrigger = (event: unknown): CompactionTrigger => {
  const { reason, willRetry } = (event ?? {}) as { reason?: unknown; willRetry?: unknown };
  return {
    reason: reason === "threshold" || reason === "overflow" ? reason : "manual",
    willRetry: willRetry === true,
  };
};

export default (pi: PiExtensionAPI) =>
  register(pi as unknown as ExtensionAPI, {
    ...PI_HOST,
    convertToLlm: (messages) => convertToLlm(messages) as any[],
    agentDir: getAgentDir,
    triggerOf: piCompactionTrigger,
  });
