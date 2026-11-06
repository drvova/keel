// vcc_pin and /omp-vcc-pin: the text the agent reads, vcc_pin's JSON Schema, and
// what a call does. unpin also takes "#3"; omp has no prepareArguments, so
// executePin reads either form.
import { lastIndex } from "../core/session-file";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  formatPin,
  formatPinList,
  nextPinId,
  PIN_CHARS,
  pinText,
  readPins,
  type PinAuthor,
  type PinOp,
} from "../core/pins";
import { PIN_ENTRY_TYPE, PIN_TOOL } from "../names";

export const PIN_TOOL_LABEL = "VCC Pin";

export const PIN_TOOL_DESCRIPTION = [
  "Pin a short note that must survive every compaction: a decision and its reason, a constraint, a fact",
  "the rest of the task depends on. Pinned notes are kept verbatim at the top of every summary until",
  "unpinned; everything else in a summary ages out on a long task.",
  "",
  "- note: the text to pin, one self-contained line (clipped at " + PIN_CHARS + " chars).",
  "- unpin: the [N] of a note that no longer holds.",
  "- neither: list the pinned notes.",
  "",
  "Pin sparingly, what you would need if you lost the conversation; the user pins with /omp-vcc-pin.",
].join("\n");

export const PIN_PARAM_DESCRIPTIONS = {
  note: "Text to pin: one self-contained line, e.g. 'Sessions live in SQLite, not Redis: the deploy host has no Redis.'",
  unpin: "The [N] of a pinned note to remove.",
} as const;

export interface PinHost {
  appendEntry: (customType: string, data?: unknown) => void;
}

export interface PinSession {
  getBranch: () => any[];
  getEntries?: () => any[];
}

const branchOf = (session: PinSession): any[] => {
  try { return session.getBranch() ?? []; } catch { return []; }
};

/** "3", "#3", "[3]", 3 -> 3. */
export const toPinId = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = value.trim().match(/^\[?#?(\d+)\]?$/);
  return m ? Number(m[1]) : undefined;
};

export const addPin = (host: PinHost, session: PinSession, raw: string, by: PinAuthor): string => {
  const { text, clipped } = pinText(raw);
  if (!text) return "Nothing to pin: give the note text.";
  const branch = branchOf(session);
  const existing = readPins(branch).find((n) => n.text === text);
  if (existing) return `Already pinned: ${formatPin(existing)}.`;
  let entries: any[] = branch;
  try { entries = session.getEntries?.() ?? branch; } catch {}
  const op: PinOp = { v: 1, op: "add", id: nextPinId(branch), text, by, ...withAt(lastIndex(entries)) };
  host.appendEntry(PIN_ENTRY_TYPE, op);
  const note = { id: op.id, text, by, ...withAt(op.at) };
  return `Pinned ${formatPin(note)}${clipped ? ` (clipped to ${PIN_CHARS} chars)` : ""}.`;
};

const withAt = (at: number | undefined) => (at != null ? { at } : {});

export const removePin = (host: PinHost, session: PinSession, idValue: unknown): string => {
  const id = toPinId(idValue);
  const notes = readPins(branchOf(session));
  const note = id == null ? undefined : notes.find((n) => n.id === id);
  if (!note) return `No pinned note ${id == null ? JSON.stringify(idValue) : `[${id}]`}. ${formatPinList(notes)}`;
  host.appendEntry(PIN_ENTRY_TYPE, { v: 1, op: "remove", id: note.id } satisfies PinOp);
  return `Unpinned ${formatPin(note)}.`;
};

export const listPins = (session: PinSession): string => formatPinList(readPins(branchOf(session)));

/** One vcc_pin call: note pins, unpin removes, neither lists. */
export const executePin = (params: unknown, host: PinHost, session: PinSession): string => {
  const p = (params && typeof params === "object" ? params : {}) as { note?: unknown; unpin?: unknown };
  const note = typeof p.note === "string" ? p.note : undefined;
  if (note && p.unpin !== undefined) return "Send note or unpin, not both, in one call.";
  if (note) return addPin(host, session, note, "agent");
  if (p.unpin !== undefined) return removePin(host, session, p.unpin);
  return listPins(session);
};

export const PIN_PARAMETERS = {
  type: "object",
  properties: {
    note: { type: "string", description: PIN_PARAM_DESCRIPTIONS.note },
    unpin: { description: PIN_PARAM_DESCRIPTIONS.unpin, anyOf: [{ type: "number" }, { type: "string" }] },
  },
} as const;

export const registerPinTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: PIN_TOOL,
    label: PIN_TOOL_LABEL,
    description: PIN_TOOL_DESCRIPTION,
    parameters: PIN_PARAMETERS,
    loadMode: "essential",
    // It writes only omp-vcc's own session entry, not the workspace.
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = executePin(params, pi, ctx.sessionManager);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
