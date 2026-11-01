// vcc_pin on omp: the shared spec with a plain JSON Schema. unpin also takes
// "#3"; omp has no prepareArguments, so executePin reads either form.
import {
  executePin,
  PIN_PARAM_DESCRIPTIONS as D,
  PIN_TOOL_DESCRIPTION,
  PIN_TOOL_LABEL,
  PIN_TOOL_NAME,
} from "../tools/pin-spec";
import type { OmpExtensionAPI } from "./api";

export const OMP_PIN_PARAMETERS = {
  type: "object",
  properties: {
    note: { type: "string", description: D.note },
    unpin: { description: D.unpin, anyOf: [{ type: "number" }, { type: "string" }] },
  },
} as const;

export const registerOmpPinTool = (pi: OmpExtensionAPI) => {
  pi.registerTool({
    name: PIN_TOOL_NAME,
    label: PIN_TOOL_LABEL,
    description: PIN_TOOL_DESCRIPTION,
    parameters: OMP_PIN_PARAMETERS,
    loadMode: "essential",
    // It writes only pi-vcc's own session entry, not the workspace.
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = executePin(params, pi, ctx.sessionManager);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
