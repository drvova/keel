// Pinned notes: what must survive every compaction, said once.
//
// The summary's other sections keep the newest few items and age the rest out,
// which is right for most of a session and wrong for the handful of things that
// stay true all along: a constraint, a decision and why, a fact the work depends
// on. A pinned note is kept verbatim at the top of every summary until it is
// unpinned (MemGPT's always-in-context "core memory", arXiv:2310.08560). The
// user pins with /omp-vcc-pin, the agent with the vcc_pin tool.
//
// Each pin or unpin is an omp-vcc `custom` session entry (in the session file, not
// in the model's context; not counted in #N). The notes are the ops replayed
// along the current branch, so a branch keeps the pins made on it and an edited
// or retried turn drops the ones made after the edit point. omp's /clear (a
// reset_boundary) hides earlier pins, as it does omp's own context notes.
import { clip } from "./content";
import { afterReset } from "./session-file";
import { PIN_ENTRY_TYPE, PIN_TOOL } from "../names";

/** One note is clipped to this many characters. */
export const PIN_CHARS = 300;
/** Notes shown in a summary; past this the newest are shown and the count says so. */
export const PINS_SHOWN = 20;

export type PinAuthor = "user" | "agent";

export interface PinnedNote {
  id: number;
  text: string;
  by: PinAuthor;
  /** Session-wide #N of the last message when the note was pinned. */
  at?: number;
}

export type PinOp =
  | { v: 1; op: "add"; id: number; text: string; by: PinAuthor; at?: number }
  | { v: 1; op: "remove"; id: number };

const isPinEntry = (e: any): boolean => e?.type === "custom" && e.customType === PIN_ENTRY_TYPE && e.data && typeof e.data === "object";

/** The notes pinned on this branch, oldest first. */
export const readPins = (branch: readonly any[]): PinnedNote[] => {
  const notes = new Map<number, PinnedNote>();
  for (const e of afterReset(branch)) {
    if (!isPinEntry(e)) continue;
    const op = e.data as Partial<PinOp> & Record<string, unknown>;
    if (!Number.isInteger(op.id)) continue;
    if (op.op === "add" && typeof op.text === "string" && op.text.trim()) {
      notes.set(op.id as number, {
        id: op.id as number,
        text: op.text,
        by: op.by === "agent" ? "agent" : "user",
        ...(Number.isInteger(op.at) ? { at: op.at as number } : {}),
      });
    } else if (op.op === "remove") {
      notes.delete(op.id as number);
    }
  }
  return [...notes.values()].sort((a, b) => a.id - b.id);
};

/** A fresh id: one past every id used on this branch, unpinned ones included, so an id never means two notes. */
export const nextPinId = (branch: readonly any[]): number => {
  let max = 0;
  for (const e of branch) if (isPinEntry(e) && Number.isInteger(e.data.id)) max = Math.max(max, e.data.id);
  return max + 1;
};

/** Normalize note text: one line, clipped. Empty when there is nothing to pin. */
export const pinText = (text: string): { text: string; clipped: boolean } => {
  const flat = text.replace(/\s+/g, " ").trim();
  return { text: clip(flat, PIN_CHARS), clipped: flat.length > PIN_CHARS };
};

export const formatPin = (n: PinnedNote): string =>
  `[${n.id}] ${n.text} (${n.by}${n.at != null ? `, #${n.at}` : ""})`;

/** The [Pinned Notes] items: the newest PINS_SHOWN, oldest first, with a count of the rest. */
export const formatPinLines = (notes: readonly PinnedNote[]): string[] => {
  const shown = notes.slice(-PINS_SHOWN);
  const hidden = notes.length - shown.length;
  return [
    ...(hidden > 0 ? [`(+${hidden} older pinned notes; ${PIN_TOOL} lists them all)`] : []),
    ...shown.map(formatPin),
  ];
};

/** The pin list as tool or command output. */
export const formatPinList = (notes: readonly PinnedNote[]): string =>
  notes.length === 0
    ? "No pinned notes."
    : `Pinned notes (kept at the top of every summary):\n${notes.map((n) => `- ${formatPin(n)}`).join("\n")}`;
