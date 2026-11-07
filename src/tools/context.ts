// vcc_context: the agent's say over what stays in its context. It takes whole
// turns out (they leave the next request, and a line naming their #N stands in
// their place) or brings them back; vcc_recall expand reads any of it word for
// word meanwhile. The core decides (lisp/src/evict.lisp, op evict).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { untilCore } from "../core/core-wait";
import type { Binding } from "../host";
import { evict } from "../core/evict";
import { CONTEXT_PARAMS, CONTEXT_TOOL, RECALL_TOOL } from "../names";

const description = (command: string): string => [
  "Decide what stays in your context. Old turns can leave it whole: nothing is summarized or rewritten,",
  `the session keeps every word, and ${RECALL_TOOL} expand:[N] reads any entry back exactly. A turn starts at`,
  "a user request and holds every call and result after it; the turn running now always stays.",
  "",
  "- no params: list the turns in context, by #N range and size, and what is out.",
  "- drop: #N refs or ranges ('#12-#40'); every turn they touch leaves from the next request.",
  "- oldest: how many of the oldest turns in context leave.",
  "- restore: #N refs or ranges of turns to bring back.",
  "- note: with drop or oldest, one line kept where the turns were (what they settled, what to look up).",
  "",
  "Drop rarely and in large runs from the oldest end: each edit makes the provider read again all that",
  `follows it. Past 85% of the window the oldest turns leave by themselves; the user evicts with /${command}-evict.`,
].join("\n");

const PARAM_DESCRIPTIONS: Record<(typeof CONTEXT_PARAMS)[number], string> = {
  drop: "#N refs or ranges of turns to take out, e.g. ['#12-#40'] or [12].",
  oldest: "How many of the oldest turns in context to take out.",
  restore: "#N refs or ranges of turns to bring back into context.",
  note: "One line kept in place of the turns taken out.",
};

const refs = { anyOf: [{ type: "array", items: { anyOf: [{ type: "number" }, { type: "string" }] } }, { type: "number" }, { type: "string" }] };

const PARAMETERS = {
  type: "object",
  properties: {
    drop: { description: PARAM_DESCRIPTIONS.drop, ...refs },
    oldest: { type: "number", description: PARAM_DESCRIPTIONS.oldest },
    restore: { description: PARAM_DESCRIPTIONS.restore, ...refs },
    note: { type: "string", description: PARAM_DESCRIPTIONS.note },
  },
} as const;

export const registerContextTool = (pi: ExtensionAPI, host: Binding) => {
  pi.registerTool({
    name: CONTEXT_TOOL,
    label: "VCC Context",
    description: description(host.command),
    parameters: PARAMETERS as any,
    loadMode: "essential",
    // It writes only omp-vcc's own session entry, not the workspace.
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = untilCore(() => evict(pi, host, ctx, { surface: "tool", params: params ?? null }));
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
