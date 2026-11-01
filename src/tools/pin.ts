// vcc_pin for Pi: the shared spec (./pin-spec) with a TypeBox schema.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  executePin,
  PIN_PARAM_DESCRIPTIONS as D,
  PIN_PROMPT_SNIPPET,
  PIN_TOOL_DESCRIPTION,
  PIN_TOOL_LABEL,
  PIN_TOOL_NAME,
  toPinId,
} from "./pin-spec";

export const registerPinTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: PIN_TOOL_NAME,
    label: PIN_TOOL_LABEL,
    description: PIN_TOOL_DESCRIPTION,
    promptSnippet: PIN_PROMPT_SNIPPET,
    parameters: Type.Object({
      note: Type.Optional(Type.String({ description: D.note })),
      unpin: Type.Optional(Type.Number({ description: D.unpin })),
    }),
    // "#3" / "[3]" for unpin is repaired before pi validates the schema.
    prepareArguments: (args: unknown) => {
      if (!args || typeof args !== "object") return {} as any;
      const a = { ...(args as Record<string, unknown>) };
      if (a.unpin !== undefined && typeof a.unpin !== "number") {
        const id = toPinId(a.unpin);
        if (id !== undefined) a.unpin = id;
      }
      return a as any;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = executePin(params, pi, ctx.sessionManager);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
