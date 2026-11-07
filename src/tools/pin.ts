// vcc_pin: the text the agent reads, its JSON Schema, and what a call does.
// unpin also takes "#3"; omp has no prepareArguments, so the schema takes a
// number or a string and removePin (core/pins.ts) reads either form.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { untilCore } from "../core/core-wait";
import type { HostProfile } from "../host";
import { addPin, listPins, PIN_CHARS, pinCallOf, pinInCore, removePin, type PinHost } from "../core/pins";
import type { SessionManagerLike } from "../core/session-file";
import { PIN_PARAMS, PIN_TOOL } from "../names";

const PIN_TOOL_LABEL = "VCC Pin";

/** What the agent reads about vcc_pin; `command` is omp-vcc's command prefix on the host. */
const pinToolDescription = (command: string): string => [
  "Pin a short note that must survive every compaction: a decision and its reason, a constraint, a fact",
  "the rest of the task depends on. Pinned notes are kept verbatim at the top of every summary until",
  "unpinned; everything else in a summary ages out on a long task.",
  "",
  "- note: the text to pin, one self-contained line (clipped at " + PIN_CHARS + " chars).",
  "- unpin: the [N] of a note that no longer holds.",
  "- neither: list the pinned notes.",
  "",
  `Pin sparingly, what you would need if you lost the conversation; the user pins with /${command}-pin.`,
].join("\n");

const PIN_PARAM_DESCRIPTIONS = {
  [PIN_PARAMS.note]: "Text to pin: one self-contained line, e.g. 'Sessions live in SQLite, not Redis: the deploy host has no Redis.'",
  [PIN_PARAMS.unpin]: "The [N] of a pinned note to remove.",
} as const;

/** One vcc_pin call: note pins, unpin removes, neither lists. */
export const executePin = (params: unknown, host: PinHost, session: SessionManagerLike): string => {
  const inCore = pinInCore(host, session, { surface: "tool", params: params ?? null });
  if (inCore) return inCore.text;
  const call = pinCallOf((params && typeof params === "object" ? params : {}) as Record<string, unknown>);
  if ("both" in call) return "Send note or unpin, not both, in one call.";
  if ("note" in call) return addPin(host, session, call.note, "agent").text;
  if ("unpin" in call) return removePin(host, session, call.unpin).text;
  return listPins(session);
};

const PIN_PARAMETERS = {
  type: "object",
  properties: {
    [PIN_PARAMS.note]: { type: "string", description: PIN_PARAM_DESCRIPTIONS[PIN_PARAMS.note] },
    [PIN_PARAMS.unpin]: { description: PIN_PARAM_DESCRIPTIONS[PIN_PARAMS.unpin], anyOf: [{ type: "number" }, { type: "string" }] },
  },
} as const;

export const registerPinTool = (pi: ExtensionAPI, host: Pick<HostProfile, "command">) => {
  pi.registerTool({
    name: PIN_TOOL,
    label: PIN_TOOL_LABEL,
    description: pinToolDescription(host.command),
    parameters: PIN_PARAMETERS,
    loadMode: "essential",
    // It writes only omp-vcc's own session entry, not the workspace.
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = untilCore(() => executePin(params, pi, ctx.sessionManager));
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
