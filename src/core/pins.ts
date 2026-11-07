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
import { PIN_ENTRY_TYPE } from "../names";
import { core } from "./lisp-core";
import { hostSnapshot, type HostCtx } from "./host-snapshot";
import type { Binding } from "../host";

export interface PinnedNote {
  id: number;
  text: string;
  by: "user" | "agent";
  /** Session-wide #N of the last message when the note was pinned. */
  at?: number;
}

/** Where a pin or unpin is written: the host's appendEntry. */
export interface PinHost {
  appendEntry: (customType: string, data?: unknown) => void;
}

/** A vcc_pin call, or the text of /…-pin or /…-unpin. */
export type PinCall = { surface: "tool"; params: unknown } | { surface: "command"; name: "pin" | "unpin"; args: string };

/** What the core made of a pin call: `done` when the note changed, what to tell, and for a command, how and what the agent hears. */
export interface PinAnswer {
  done: boolean;
  text: string;
  severity?: "info" | "warning";
  agentNote?: string;
}

/** The call in the core (lisp/src/pins.lisp, op pin), with the entry it decided appended through the host. */
export const pin = (host: PinHost, binding: Parameters<typeof hostSnapshot>[0], ctx: HostCtx, call: PinCall): PinAnswer => {
  const { op, ...answer } = core({ op: "pin", host: hostSnapshot(binding, ctx), call }).pin as PinAnswer & { op?: unknown };
  if (op) host.appendEntry(PIN_ENTRY_TYPE, op);
  return answer;
};
