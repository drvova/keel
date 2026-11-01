// vcc_recall for Pi: the shared spec (./recall-spec) with a TypeBox schema.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeToolParams } from "../core/recall-request";
import { invalidExpandIndices } from "../core/recall-run";
import {
  executeRecall,
  RECALL_PARAM_DESCRIPTIONS as D,
  RECALL_PROMPT_SNIPPET,
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_LABEL,
  RECALL_TOOL_NAME,
} from "./recall-spec";

export { invalidExpandIndices };

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: RECALL_TOOL_LABEL,
    description: RECALL_TOOL_DESCRIPTION,
    promptSnippet: RECALL_PROMPT_SNIPPET,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: D.query })),
      range: Type.Optional(
        Type.Array(Type.Number(), { minItems: 2, maxItems: 2, description: D.range }),
      ),
      expand: Type.Optional(Type.Array(Type.Number(), { description: D.expand })),
      page: Type.Optional(Type.Number({ description: D.page })),
      scope: Type.Optional(
        Type.Union([Type.Literal("lineage"), Type.Literal("all"), Type.Literal("project")], { description: D.scope }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("hybrid"), Type.Literal("touched"), Type.Literal("sessions")], { description: D.mode }),
      ),
      session: Type.Optional(Type.String({ description: D.session })),
    }),
    // Runs before pi validates the schema, so repairable mistakes never reach the agent as errors.
    prepareArguments: (args: unknown) => normalizeToolParams(args) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = executeRecall(params, ctx.sessionManager, { contextWindow: (ctx as any).model?.contextWindow });
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
