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
  const stubs = new Map((reply.stubs as Array<{ at: number; text: string }>).map((s) => [s.at, s.text]));
  if (drop.size === 0 && stubs.size === 0) return { messages: undefined, notice: reply.notice as string | undefined };
  const out: unknown[] = [];
  messages.forEach((m, i) => {
    const stub = stubs.get(i);
    // The line stands where the turns were, as the user's: the timestamp of the first one it replaces.
    if (stub !== undefined) out.push({ role: "user", content: [{ type: "text", text: stub }], timestamp: (m as { timestamp?: unknown })?.timestamp });
    if (!drop.has(i)) out.push(m);
  });
  return { messages: out, notice: reply.notice as string | undefined };
};
