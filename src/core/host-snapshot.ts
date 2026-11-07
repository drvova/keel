// What the host knows at an event, as the one snapshot every op for it carries
// (lisp/src/host.lisp reads it). The core counts #N, finds the branch, loads the
// settings and works out the window from it; nothing here reduces the session
// for one op or another.
import type { HostProfile } from "../host";
import type { Config } from "./settings";
import { hostBranch, hostEntries, type SessionManagerLike } from "./session-file";
import { EVICT_ENTRY_TYPE, PIN_ENTRY_TYPE } from "../names";

/** What a host's ctx offers omp-vcc at an event. */
export interface HostCtx {
  sessionManager?: SessionManagerLike;
  model?: { provider?: string; id?: string; contextWindow?: number | null } | null;
  getContextUsage?: () => { tokens?: number | null } | undefined;
  /** The session's working directory, as both hosts' ctx carry it. */
  cwd?: string;
}

/**
 * One entry as the snapshot carries it: its place in the tree and what it is,
 * without its body. A message is its role, time, attribution and a tool
 * result's call id, so #N, the branch, the turns and a request's messages read
 * from it; a compaction keeps where its kept tail starts; omp-vcc's own pin and
 * evict entries keep their data, which the pins and the evictions are read from.
 */
const skeleton = (e: any): Record<string, unknown> => ({
  type: e?.type,
  id: e?.id,
  parentId: e?.parentId,
  ...(typeof e?.customType === "string" ? { customType: e.customType } : {}),
  ...(e?.customType === PIN_ENTRY_TYPE || e?.customType === EVICT_ENTRY_TYPE ? { data: e.data } : {}),
  ...(e?.type === "compaction" ? { firstKeptEntryId: e.firstKeptEntryId, providerReplayThroughEntryId: e.providerReplayThroughEntryId } : {}),
  ...(e && "message" in e ? { message: e.message == null ? null : messageSkeleton(e.message) } : {}),
});

const messageSkeleton = (m: any): Record<string, unknown> => ({
  role: m.role,
  ...(m.timestamp !== undefined ? { timestamp: m.timestamp } : {}),
  ...(typeof m.attribution === "string" ? { attribution: m.attribution } : {}),
  ...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
});

export const hostSnapshot = (host: Pick<HostProfile, "name" | "displayName" | "modelsFile"> & { config: Pick<Config, "path"> }, ctx: HostCtx | undefined) => {
  const sm = ctx?.sessionManager;
  const branch = hostBranch(sm) ?? [];
  const tree = hostEntries(sm) ?? branch;
  let tokens: number | null = null;
  try { tokens = ctx?.getContextUsage?.()?.tokens ?? null; } catch {}
  const m = ctx?.model;
  return {
    name: host.name,
    displayName: host.displayName,
    modelsFile: host.modelsFile,
    configPath: host.config.path(),
    sessionFile: sm?.getSessionFile?.() ?? null,
    cwd: ctx?.cwd ?? process.cwd(),
    model: m ? { provider: m.provider, id: m.id, contextWindow: m.contextWindow } : null,
    contextTokens: tokens,
    tree: tree.map(skeleton),
    branch: branch.flatMap((e: any) => (typeof e?.id === "string" && e.id ? [e.id] : [])),
  };
};
