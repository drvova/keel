// Turns out of the context, by the agent (keel_context), the user
// (/keel-evict) or keel as the context fills: the core decides
// (lisp/src/evict.lisp, ops evict and context); each decision is a keel
// custom entry the host appends, replayed along the branch as pins are.
import { EVICT_ENTRY_TYPE } from "../names";
import { core } from "./lisp-core";
import { hostSnapshot, type HostCtx } from "./host-snapshot";

/** Where an eviction is recorded: the host's appendEntry. */
export interface EvictHost {
  appendEntry: (customType: string, data?: unknown) => void;
}

/** A keel_context call, or the text of /…-evict. */
export type EvictCall = { surface: "tool"; params: unknown } | { surface: "command"; args: string };

/** The call in the core, with the entries it decided appended through the host: what to tell. */
export const evict = (host: EvictHost, binding: Parameters<typeof hostSnapshot>[0], ctx: HostCtx, call: EvictCall): string => {
  const reply = core({ op: "evict", host: hostSnapshot(binding, ctx), call });
  for (const op of reply.ops as unknown[]) host.appendEntry(EVICT_ENTRY_TYPE, op);
  return reply.text as string;
};

/** What the core makes of the host's next request: the request to send (undefined: as it is), the note for the model, what to tell the user. */
export interface RequestEvictions {
  messages: unknown[] | undefined;
  /** How full the context is, for the model, as a message of its own (BUDGET_NOTICE_TYPE). */
  note: string | undefined;
  notice: string | undefined;
}

/**
 * The host's next request with what is out of the context left out. The
 * evictions keel decides as the context fills are appended before the
 * request goes, so the next request finds them in the ledger. `tool` says
 * whether keel_context is registered, which the note names.
 */
export const evictRequest = (host: EvictHost, binding: Parameters<typeof hostSnapshot>[0], ctx: HostCtx, messages: unknown[], tool = false): RequestEvictions => {
  const reply = core({ op: "context", host: hostSnapshot(binding, ctx), messages, tool });
  for (const op of reply.ops as unknown[]) host.appendEntry(EVICT_ENTRY_TYPE, op);
  const note = reply.note as string | undefined;
  const notice = reply.notice as string | undefined;
  const drop = new Set(reply.drop as number[]);
  const lines = reply.stubs as Placed[];
  if (drop.size === 0 && lines.length === 0) return { messages: undefined, note, notice };
  // Where each line goes, and the message a line of its own is, are the core's.
  const out: unknown[] = [];
  messages.forEach((m, i) => {
    const here = lines.filter((l) => l.at === i);
    for (const l of here) if (l.how === "insert" && l.message) out.push(l.message);
    if (drop.has(i)) return;
    const before = here.filter((l) => l.how === "prepend").map((l) => l.text);
    const after = here.filter((l) => l.how === "append").map((l) => l.text);
    out.push(before.length || after.length ? withText(m, before, after) : m);
  });
  return { messages: out, note, notice };
};

interface Placed { at: number; how: "prepend" | "append" | "insert"; text: string; message?: unknown }

/** MESSAGE with text parts put before and after its content. */
const withText = (message: unknown, before: string[], after: string[]): unknown => {
  const m = message as { content?: unknown };
  const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
  const text = (t: string) => ({ type: "text", text: t });
  return { ...m, content: [...before.map(text), ...parts, ...after.map(text)] };
};
