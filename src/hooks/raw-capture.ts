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
import { loadSettings } from "../core/settings";

interface SessionManagerLike {
  getSessionFile?: () => string | undefined;
  getEntries?: () => any[];
}

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
    // Another session (a switch, /new, a resume): start from its first entry, after what its store holds.
    state.file = file;
    state.seen = 0;
    state.kept = rawStoreIds(file);
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
};
