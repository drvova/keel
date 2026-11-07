// Turns out of the context, by the agent (vcc_context), the user
// (/omp-vcc-evict) or omp-vcc as the context fills: the core decides
// (lisp/src/evict.lisp, ops evict and context); each decision is an omp-vcc
// custom entry the host appends, replayed along the branch as pins are.
import { EVICT_ENTRY_TYPE } from "../names";
import { core } from "./lisp-core";
import { hostSnapshot, type HostCtx } from "./host-snapshot";

/** Where an eviction is recorded: the host's appendEntry. */
export interface EvictHost {
  appendEntry: (customType: string, data?: unknown) => void;
}

/** A vcc_context call, or the text of /…-evict. */
export type EvictCall = { surface: "tool"; params: unknown } | { surface: "command"; args: string };

/** The call in the core, with the entries it decided appended through the host: what to tell. */
export const evict = (host: EvictHost, binding: Parameters<typeof hostSnapshot>[0], ctx: HostCtx, call: EvictCall): string => {
  const reply = core({ op: "evict", host: hostSnapshot(binding, ctx), call });
  for (const op of reply.ops as unknown[]) host.appendEntry(EVICT_ENTRY_TYPE, op);
  return reply.text as string;
};

/** What the core makes of the host's next request: which messages leave, what stands in their place, what it recorded. */
export interface RequestEvictions {
  messages: unknown[] | undefined;
  notice: string | undefined;
}

/**
 * The host's next request with what is out of the context left out. The
 * evictions omp-vcc decides as the context fills are appended before the
 * request goes, so the next request finds them in the ledger.
 */
export const evictRequest = (host: EvictHost, binding: Parameters<typeof hostSnapshot>[0], ctx: HostCtx, messages: unknown[]): RequestEvictions => {
  const reply = core({ op: "context", host: hostSnapshot(binding, ctx), messages });
  for (const op of reply.ops as unknown[]) host.appendEntry(EVICT_ENTRY_TYPE, op);
  const drop = new Set(reply.drop as number[]);
  // Where each line goes is the core's: prepended to a user message, appended to one, or a message of its own.
  const lines = [...(reply.stubs as Placed[]), ...(reply.budget ? [{ ...(reply.budget as Placed), how: "append" as const }] : [])];
  if (drop.size === 0 && lines.length === 0) return { messages: undefined, notice: reply.notice as string | undefined };
  const out: unknown[] = [];
  messages.forEach((m, i) => {
    const here = lines.filter((l) => l.at === i);
    // A line of its own stands where the turns were, as the user's: the timestamp of the first one it replaces.
    for (const l of here.filter((l) => l.how === "insert")) out.push({ role: "user", content: [{ type: "text", text: l.text }], timestamp: (m as { timestamp?: unknown })?.timestamp });
    if (drop.has(i)) return;
    const before = here.filter((l) => l.how === "prepend").map((l) => l.text);
    const after = here.filter((l) => l.how === "append").map((l) => l.text);
    out.push(before.length || after.length ? withText(m, before, after) : m);
  });
  return { messages: out, notice: reply.notice as string | undefined };
};

interface Placed { at: number; how: "prepend" | "append" | "insert"; text: string }

/** MESSAGE with text parts put before and after its content. */
const withText = (message: unknown, before: string[], after: string[]): unknown => {
  const m = message as { content?: unknown };
  const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
  const text = (t: string) => ({ type: "text", text: t });
  return { ...m, content: [...before.map(text), ...parts, ...after.map(text)] };
};
