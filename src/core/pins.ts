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
import { hostBranch, hostEntries, RESET_ENTRY_TYPE, type SessionManagerLike } from "./session-file";
import { PIN_ENTRY_TYPE } from "../names";
import { core } from "./lisp-core";

/** One note is clipped to this many characters. */
export const PIN_CHARS = 300;

type PinAuthor = "user" | "agent";

export interface PinnedNote {
  id: number;
  text: string;
  by: PinAuthor;
  /** Session-wide #N of the last message when the note was pinned. */
  at?: number;
}

type PinOp =
  | { v: 1; op: "add"; id: number; text: string; by: PinAuthor; at?: number }
  | { v: 1; op: "remove"; id: number };

const isPinEntry = (e: any): boolean => e?.type === "custom" && e.customType === PIN_ENTRY_TYPE && e.data && typeof e.data === "object";

/** An entry the core replays to read the pins: a pin op, or a /clear boundary that ends what came before it. */
export const replaysPins = (e: any): boolean => isPinEntry(e) || e?.type === RESET_ENTRY_TYPE;

// ── Pinning and unpinning, for the tool and the commands ──

/** Where a pin or unpin is written: the host's appendEntry. */
export interface PinHost {
  appendEntry: (customType: string, data?: unknown) => void;
}

/** What a pin or unpin did: `done` when the note changed, `text` what to tell. */
interface PinResult {
  done: boolean;
  text: string;
}

const branchOf = (session: SessionManagerLike): any[] => hostBranch(session) ?? [];

/** A vcc_pin call, or the text of /…-pin or /…-unpin. */
export type PinCall = { surface: "tool"; params: unknown } | { surface: "command"; name: "pin" | "unpin"; args: string };

/** What the Lisp core made of a pin call: what to tell, and for a command, how and what the agent hears. */
export interface PinAnswer extends PinResult {
  severity?: "info" | "warning";
  agentNote?: string;
}

/**
 * The call in the Lisp core (lisp/src/pins.lisp, op pin), with the op it
 * decided appended through the host; undefined without the core. It gets the
 * branch's pin entries and /clear boundaries, and of every entry what #N
 * counts (its type, whether it holds a message).
 */
export const pinInCore = (host: PinHost, session: SessionManagerLike, call: PinCall): PinAnswer => {
  const branch = branchOf(session);
  const entries = (hostEntries(session) ?? branch).map((e: any) => ({ type: e?.type, ...(e?.message != null ? { message: 1 } : {}) }));
  const answer = core({ op: "pin", input: { call, branch: branch.filter(replaysPins), entries } }).pin as PinAnswer & { op?: PinOp };
  if (answer.op) host.appendEntry(PIN_ENTRY_TYPE, answer.op);
  return { done: answer.done, text: answer.text, ...(answer.severity ? { severity: answer.severity } : {}), ...(answer.agentNote ? { agentNote: answer.agentNote } : {}) };
};
