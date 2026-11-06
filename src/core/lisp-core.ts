import { spawnSync } from "node:child_process";
import type { SearchHit, SearchResult } from "./search-entries";

/**
 * The Lisp core (lisp/): one JSON request on its stdin, one response on its
 * stdout, then it exits (lisp/src/server.lisp). spawnSync keeps the callers
 * synchronous; a start costs ~5 ms.
 *
 * It is found through OMP_VCC_CORE, the executable's path, while the port is
 * under way. Every failure (no core, a crash, a refusal, a reply that does not
 * parse) is undefined, and the caller runs the TypeScript code instead: a
 * broken core costs speed, never an answer.
 */
export const callCore = (request: object): Record<string, unknown> | undefined => {
  const core = process.env.OMP_VCC_CORE;
  if (!core) return undefined;
  const run = spawnSync(core, [], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 30 });
  if (run.error || run.status !== 0) return undefined;
  try {
    const reply = JSON.parse(run.stdout);
    return reply && typeof reply === "object" && reply.ok === true ? reply : undefined;
  } catch {
    return undefined;
  }
};

/** A session file for the core to read and search: the entries on `ids` (the file's own active branch for "active", all for null), less `skip`. */
export interface CoreSource {
  file: string;
  ids: string[] | "active" | null;
  skip?: number[];
  /** Short id of an earlier session, set on its hits. */
  session?: string;
  /** The file's size, which a project search counts against its byte bound. */
  bytes?: number;
}

/**
 * Search session files in the core (op search-sessions, lisp/src/server.lisp):
 * the first source always, each later one while the corpus stays within the
 * bounds. Undefined when there is no core, it fails, or the query is a regex it
 * leaves to the TS search.
 */
export const searchSessionsInCore = (
  query: string,
  sources: CoreSource[],
  bounds: { maxBytes?: number; maxEntries?: number } = {},
): { result: SearchResult; searched: number } | undefined => {
  const reply = callCore({ op: "search-sessions", query, sources, ...bounds });
  if (!reply || !Array.isArray(reply.hits)) return undefined;
  const hits: SearchHit[] = (reply.hits as Array<Record<string, any>>).map((h) => ({
    index: h.index,
    role: h.role,
    summary: h.summary,
    ...(Array.isArray(h.files) ? { files: h.files } : {}),
    ...(typeof h.session === "string" ? { session: h.session } : {}),
    snippet: h.snippet ?? undefined,
  }));
  return {
    result: { hits, totalBeforeCap: reply.totalBeforeCap as number, truncated: reply.truncated === true },
    searched: reply.searched as number,
  };
};
