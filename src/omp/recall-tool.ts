// vcc_recall on omp: the shared spec with a plain JSON Schema.
//
// omp validates arguments before any extension code runs and has no
// prepareArguments hook, so the schema also accepts the forms pi-vcc's own
// normalizer repairs (an index as "#12", a range as "10-20", a scope value in
// mode, enum values in another case); execute() then normalizes them. omp drops
// unknown keys itself, before execute().
import {
  executeRecall,
  RECALL_PARAM_DESCRIPTIONS as D,
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_LABEL,
  RECALL_TOOL_NAME,
} from "../tools/recall-spec";
import type { OmpExtensionAPI } from "./api";

const numberOrText = { anyOf: [{ type: "number" }, { type: "string" }] };

export const OMP_RECALL_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: D.query },
    range: {
      description: D.range,
      anyOf: [{ type: "array", items: numberOrText }, { type: "string" }, { type: "number" }],
    },
    expand: {
      description: D.expand,
      anyOf: [{ type: "array", items: numberOrText }, { type: "string" }, { type: "number" }],
    },
    page: { description: D.page, ...numberOrText },
    scope: { type: "string", description: D.scope },
    mode: { type: "string", description: D.mode },
  },
} as const;

export const registerOmpRecallTool = (pi: OmpExtensionAPI) => {
  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: RECALL_TOOL_LABEL,
    description: RECALL_TOOL_DESCRIPTION,
    parameters: OMP_RECALL_PARAMETERS,
    // The summary tells the agent to call vcc_recall by name, so keep it top-level
    // rather than behind omp's tool discovery; it only reads the session file.
    loadMode: "essential",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = executeRecall(params, ctx.sessionManager, { normalize: true });
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
