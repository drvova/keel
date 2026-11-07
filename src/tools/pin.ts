// vcc_pin: the text the agent reads, its JSON Schema, and what a call does.
// unpin also takes "#3"; omp has no prepareArguments, so the schema takes a
// number or a string and the core (lisp/src/pins.lisp) reads either form.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { untilCore } from "../core/core-wait";
import type { HostProfile } from "../host";
import { pinInCore, type PinHost } from "../core/pins";
import type { SessionManagerLike } from "../core/session-file";
import { PIN_CHARS, PIN_PARAMS, PIN_TOOL } from "../names";

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

const PIN_PARAM_DESCRIPTIONS: Record<(typeof PIN_PARAMS)[number], string> = {
  note: "Text to pin: one self-contained line, e.g. 'Sessions live in SQLite, not Redis: the deploy host has no Redis.'",
  unpin: "The [N] of a pinned note to remove.",
};

/** One vcc_pin call: note pins, unpin removes, neither lists. */
export const executePin = (params: unknown, host: PinHost, session: SessionManagerLike): string =>
  pinInCore(host, session, { surface: "tool", params: params ?? null }).text;

const PIN_PARAMETERS = {
  type: "object",
  properties: {
    note: { type: "string", description: PIN_PARAM_DESCRIPTIONS.note },
    unpin: { description: PIN_PARAM_DESCRIPTIONS.unpin, anyOf: [{ type: "number" }, { type: "string" }] },
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
