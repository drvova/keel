// Copies what omp may rewrite in the session file as it lands
// (core/raw-store.ts), so vcc_recall keeps the originals. It reads omp's own
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
import { appendRawStore, keptContent, mayBeRewritten, rawStoreIds, type RawRecord } from "../core/raw-store";
import { indexById, sessionLineage, type SessionManagerLike } from "../core/session-file";
import { loadSettings } from "../core/settings";
import { RECALL_TOOL } from "../names";

/** One binding's place in its session: which file, how many entries it has looked at, which are kept. */
export interface RawCaptureState {
  file?: string;
  seen: number;
  kept: Set<string>;
}

export const createRawCaptureState = (): RawCaptureState => ({ seen: 0, kept: new Set() });

/** Copy what arrived since the last call. Returns the number of messages kept. */
export const captureNewEntries = (state: RawCaptureState, sessionManager: SessionManagerLike | undefined): number => {
  const file = sessionManager?.getSessionFile?.();
  if (!file) return 0;
  if (file !== state.file) {
    // Another session (a switch, /new, a resume, a fork): start from its first
    // entry, after what its store and its parents' stores hold (a fork carries
    // its parent's entries, the rewritten ones' originals in the parent's store).
    state.file = file;
    state.seen = 0;
    state.kept = new Set(sessionLineage(file).flatMap((f) => [...rawStoreIds(f)]));
  }
  const entries = sessionManager?.getEntries?.() ?? [];
  if (entries.length < state.seen) state.seen = 0;
  const records: RawRecord[] = [];
  for (let i = state.seen; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.type !== "message" || typeof entry.id !== "string" || state.kept.has(entry.id)) continue;
    if (!mayBeRewritten(entry.message)) continue;
    records.push({ id: entry.id, content: keptContent(entry.message.content) });
  }
  state.seen = entries.length;
  if (records.length === 0) return 0;
  try {
    appendRawStore(file, records);
    for (const r of records) state.kept.add(r.id);
  } catch {
    return 0;
  }
  return records.length;
};

/** omp's placeholders for a tool result it blanked (pi-agent-core pruning.ts). */
const OMP_PLACEHOLDER = /^\[(?:Output truncated - \d+ tokens|Superseded by a newer read of this file|Uneventful result elided)\]$/;

/**
 * The request's messages with each placeholder omp wrote over a tool result
 * whose original omp-vcc kept followed by where to read it, or undefined when
 * there is none. A placeholder alone reads as content that is gone, and an
 * agent runs the tool again to get it back; a pointer to the kept original
 * avoids that (masked observations stay reachable by id, arXiv:2606.00408).
 * The ref is the entry's session-wide #N, so the text is the same on every
 * request and the provider's prompt cache keeps it.
 */
export const pointPlaceholders = (messages: unknown[], state: RawCaptureState, sessionManager: SessionManagerLike | undefined): unknown[] | undefined => {
  const hits: Array<{ i: number; text: string; callId: string }> = [];
  messages.forEach((m: any, i) => {
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string" || !Array.isArray(m.content) || m.content.length !== 1) return;
    const part = m.content[0];
    if (part?.type === "text" && typeof part.text === "string" && OMP_PLACEHOLDER.test(part.text)) hits.push({ i, text: part.text, callId: m.toolCallId });
  });
  if (hits.length === 0 || state.kept.size === 0) return undefined;
  // The tool result each call id names on the active path (a reused id after an interrupted call: the latest).
  const byCall = new Map<string, string>();
  for (const e of sessionManager?.getBranch?.() ?? []) {
    if (e?.type === "message" && e.message?.role === "toolResult" && typeof e.message.toolCallId === "string") byCall.set(e.message.toolCallId, e.id);
  }
  const index = indexById(sessionManager?.getEntries?.() ?? []);
  let out: unknown[] | undefined;
  for (const { i, text, callId } of hits) {
    const id = byCall.get(callId);
    const n = id ? index.get(id) : undefined;
    if (!id || n === undefined || !state.kept.has(id)) continue;
    out ??= [...messages];
    const m = messages[i] as Record<string, unknown>;
    out[i] = { ...m, content: [{ type: "text", text: `${text} (the original: ${RECALL_TOOL} expand:[${n}])` }] };
  }
  return out;
};

/** Keep originals for the session this binding serves (`keepOriginals`, default on). */
export const registerRawCapture = (pi: ExtensionAPI, state: RawCaptureState = createRawCaptureState()): void => {
  const capture = (ctx: unknown) => {
    try {
      if (!loadSettings().keepOriginals) return;
      captureNewEntries(state, (ctx as { sessionManager?: SessionManagerLike })?.sessionManager);
    } catch {}
  };
  pi.on("session_start", (_event, ctx) => capture(ctx));
  pi.on("message_end", (_event, ctx) => capture(ctx));
  pi.on("turn_end", (_event, ctx) => capture(ctx));
  pi.on("agent_end", (_event, ctx) => capture(ctx));
  pi.on("context", (event, ctx) => {
    try {
      if (!loadSettings().keepOriginals) return;
      const sessionManager = (ctx as { sessionManager?: SessionManagerLike })?.sessionManager;
      // Entries that arrived since the last event, so a result omp just blanked is known to be kept.
      captureNewEntries(state, sessionManager);
      const messages = pointPlaceholders((event as { messages?: unknown[] }).messages ?? [], state, sessionManager);
      return messages ? { messages: messages as any } : undefined;
    } catch {
      return undefined;
    }
  });
};
