// Copies what omp may rewrite in the session file as it lands
// (<session>.jsonl.keel-raw, lisp/src/raw-capture.lisp), so keel_recall keeps the originals. It reads omp's own
// entries (the persisted form), not the event's message: omp shows extensions a
// de-obfuscated copy of an assistant message, and the copy keeps what the
// session file keeps.
//
// omp persists a message after it tells extensions of it, so each event copies
// the entries that arrived since the last one. omp's rewrites never touch the
// newest messages (it protects the latest 40K tokens of tool output and the
// read a newer read supersedes is an older one), so a message is copied well
// before omp could rewrite it.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { hostEntries, type SessionManagerLike } from "../core/session-file";
import type { Config } from "../core/settings";
import { core } from "../core/lisp-core";
import { whenCore } from "../core/core-wait";
import { hostSnapshot, type HostCtx } from "../core/host-snapshot";

/** One binding's place in its session: which file, how many entries it has looked at, which are kept. */
interface RawCaptureState {
  file?: string;
  seen: number;
  kept: Set<string>;
}

export const createRawCaptureState = (): RawCaptureState => ({ seen: 0, kept: new Set() });

/** Copy what arrived since the last call. Returns the number of messages kept. */
export const captureNewEntries = (state: RawCaptureState, sessionManager: SessionManagerLike | undefined): number => {
  const file = sessionManager?.getSessionFile?.();
  if (!file) return 0;
  // Another session (a switch, /new, a resume, a fork): start from its first
  // entry, after what its store and its parents' stores hold (a fork carries
  // its parent's entries, the rewritten ones' originals in the parent's store).
  const switched = file !== state.file;
  const entries = hostEntries(sessionManager) ?? [];
  const seen = switched || entries.length < state.seen ? 0 : state.seen;
  const kept = switched ? new Set<string>() : state.kept;
  // The Lisp core decides what to keep and appends the store (lisp/src/raw-capture.lisp, op raw-capture).
  // The binding's place changes only once it answered: while the core is not there yet, the next event tries again from here.
  const fresh = entries.slice(seen).filter((e: any) => e?.type === "message");
  const inCore = core({ op: "raw-capture", input: { file, entries: fresh, kept: fresh.flatMap((e: any) => (kept.has(e.id) ? [e.id] : [])), lineage: switched } });
  if (switched) {
    state.file = file;
    state.kept = kept;
  }
  state.seen = seen;
  for (const id of (inCore.lineage as string[] | undefined) ?? []) state.kept.add(id);
  // Seen only once kept: a failed write (a full disk) is tried again on the next event.
  if (inCore.stored !== true) return 0;
  const written = inCore.written as string[];
  for (const id of written) state.kept.add(id);
  state.seen = entries.length;
  return written.length;
};

/**
 * The request's messages with each placeholder omp wrote over a tool result
 * whose original keel kept followed by where to read it, or undefined when
 * there is none. A placeholder alone reads as content that is gone, and an
 * agent runs the tool again to get it back; a pointer to the kept original
 * avoids that (masked observations stay reachable by id, arXiv:2606.00408).
 * The ref is the entry's session-wide #N, so the text is the same on every
 * request and the provider's prompt cache keeps it.
 */
export const pointPlaceholders = (messages: unknown[], state: RawCaptureState, host: Parameters<typeof hostSnapshot>[0], ctx: HostCtx): unknown[] | undefined => {
  if (state.kept.size === 0) return undefined;
  // The request's tool results of the one-text-block shape omp writes a placeholder in.
  const candidates = messages.flatMap((m: any, i) =>
    m?.role === "toolResult" && typeof m.toolCallId === "string" && Array.isArray(m.content) && m.content.length === 1
      && m.content[0]?.type === "text" && typeof m.content[0].text === "string"
      ? [{ i, callId: m.toolCallId, text: m.content[0].text }] : []);
  if (candidates.length === 0) return undefined;
  const replace = core({ op: "placeholders", host: hostSnapshot(host, ctx), candidates, kept: [...state.kept] }).replace as Array<{ i: number; text: string }>;
  if (replace.length === 0) return undefined;
  const out = [...messages];
  for (const { i, text } of replace) out[i] = { ...(messages[i] as Record<string, unknown>), content: [{ type: "text", text }] };
  return out;
};


/** Keep originals for the session this binding serves (`keepOriginals`, default on). */
export const registerRawCapture = (pi: ExtensionAPI, host: Parameters<typeof hostSnapshot>[0] & { config: Pick<Config, "load"> }): void => {
  const { config } = host;
  const state = createRawCaptureState();
  // While the core is not there yet, the next event tries again from where this one was.
  const capture = (ctx: unknown) => {
    whenCore(() => {
      if (config.load().keepOriginals) captureNewEntries(state, (ctx as { sessionManager?: SessionManagerLike })?.sessionManager);
    });
  };
  pi.on("session_start", (_event, ctx) => capture(ctx));
  pi.on("message_end", (_event, ctx) => capture(ctx));
  pi.on("turn_end", (_event, ctx) => capture(ctx));
  pi.on("agent_end", (_event, ctx) => capture(ctx));
  pi.on("context", (event, ctx) =>
    whenCore(() => {
      if (!config.load().keepOriginals) return undefined;
      // Entries that arrived since the last event, so a result omp just blanked is known to be kept.
      captureNewEntries(state, (ctx as { sessionManager?: SessionManagerLike })?.sessionManager);
      const messages = pointPlaceholders((event as { messages?: unknown[] }).messages ?? [], state, host, ctx as HostCtx);
      return messages ? { messages: messages as any } : undefined;
    }));
};
