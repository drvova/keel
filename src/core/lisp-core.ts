import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SearchHit, SearchResult } from "./search-entries";

/**
 * The Lisp core (lisp/): one JSON request on its stdin, one response on its
 * stdout, then it exits (lisp/src/server.lisp). spawnSync keeps the callers
 * synchronous; a start costs ~5 ms.
 *
 * Which executable: OMP_VCC_CORE when it names one, else the build of this
 * copy's lisp/ sources, lisp/build/omp-vcc-core-<hash of the sources> (or in
 * OMP_VCC_CORE_BUILD_DIR), which
 * omp-vcc builds itself with the user's SBCL the first time it is needed (in
 * the background, a few seconds; an update of the sources builds again).
 *
 * While it is not there (being built, no SBCL, a failed build) a call throws
 * CoreUnavailable, which says why in words a user can act on; each surface
 * catches it and steps aside or tells (src/core/core-wait.ts). A core that
 * fails throws too. OMP_VCC_CORE=off answers undefined: the tests' TypeScript
 * side, while TypeScript copies remain to compare against.
 */
export const callCore = (request: object): Record<string, unknown> | undefined => {
  const status = coreStatus();
  if (status.state === "off") return undefined;
  if (status.state !== "ready") throw new CoreUnavailable(status);
  const run = spawnSync(status.path, [], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 30 });
  let reply: any;
  try { reply = run.error || run.status !== 0 ? undefined : JSON.parse(run.stdout); } catch {}
  if (reply?.ok === true) return reply;
  throw new Error(`omp-vcc's core failed: ${reply?.error ?? run.error?.message ?? (run.stderr || `exit ${run.status}`)}`);
};

/** The core cannot answer yet, or here: `message` says why, as a user is told. */
export class CoreUnavailable extends Error {
  constructor(readonly status: Exclude<CoreStatus, { state: "ready" } | { state: "off" }>) {
    super(coreUnavailableText(status));
  }
}

const coreUnavailableText = (status: CoreUnavailable["status"]): string => {
  switch (status.state) {
    case "building": return "omp-vcc is building its core, once for this version (a few seconds); until then it steps aside.";
    case "no-sbcl": return `omp-vcc needs SBCL to build its core and found none (${status.sbcl}): install SBCL (apt install sbcl, brew install sbcl, or sbcl.org), or set SBCL to its path, and start a new session; until then it steps aside.`;
    case "failed": return `omp-vcc could not build its core with SBCL: ${status.why}`;
  }
};

/** Where the core stands: ready at a path, being built, or not buildable here (and why). */
export type CoreStatus =
  | { state: "ready"; path: string }
  | { state: "off" }
  | { state: "building" }
  | { state: "no-sbcl"; sbcl: string }
  | { state: "failed"; why: string };

const LISP_DIR = fileURLToPath(new URL("../../lisp/", import.meta.url));
/** Where builds go: lisp/build, or OMP_VCC_CORE_BUILD_DIR (an install whose own directory is read-only). */
const buildDir = (): string => process.env.OMP_VCC_CORE_BUILD_DIR || join(LISP_DIR, "build");
/** A lock older than this is a build that died with its process: built again. */
const STALE_LOCK_MS = 15 * 60_000;

/** The sources the core is built from, every .lisp and .asd under lisp/ but the build. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "build" ? [] : sourceFiles(p);
    return /\.(lisp|asd)$/.test(d.name) ? [p] : [];
  }).sort();

let sourcesHash: string | undefined;
/** The build of these sources: its path is named by their hash, so an update builds again. */
const buildOfSources = (): { hash: string; path: string } => {
  if (sourcesHash) return { hash: sourcesHash, path: join(buildDir(), `omp-vcc-core-${sourcesHash}`) };
  const h = createHash("sha256");
  for (const f of sourceFiles(LISP_DIR)) h.update(relative(LISP_DIR, f)).update("\0").update(readFileSync(f)).update("\0");
  sourcesHash = h.digest("hex").slice(0, 16);
  return buildOfSources();
};

/** One build per installed copy, shared by every binding of this process. */
let building: CoreStatus | undefined;

/** The core's state now; starts the build when it is neither there nor being built. */
export const coreStatus = (): CoreStatus => {
  const named = process.env.OMP_VCC_CORE;
  if (named === "off") return { state: "off" };
  if (named) return { state: "ready", path: named };
  const { path } = buildOfSources();
  if (existsSync(path)) return { state: "ready", path };
  if (building && building.state !== "building") return building;
  return (building = startBuild(path));
};

const startBuild = (path: string): CoreStatus => {
  const sbcl = process.env.SBCL ?? "sbcl";
  if (spawnSync(sbcl, ["--version"], { stdio: "ignore" }).status !== 0) return { state: "no-sbcl", sbcl };
  const dir = buildDir();
  mkdirSync(dir, { recursive: true });
  // Another process (another omp or Pi session) may be building it already.
  const lock = `${path}.lock`;
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
    closeSync(openSync(lock, "wx"));
  } catch {
    return { state: "building" };
  }
  const out = `${path}.tmp-${process.pid}`;
  let stderr = "";
  const child = spawn(sbcl, ["--noinform", "--non-interactive", "--load", join(LISP_DIR, "build.lisp")], {
    env: { ...process.env, OMP_VCC_CORE_OUT: out },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.stderr?.on("data", (d) => { stderr = (stderr + String(d)).slice(-2_000); });
  child.on("exit", (code) => {
    try {
      if (code === 0 && existsSync(out)) {
        renameSync(out, path);
        // Builds of older sources are of no use now.
        for (const f of readdirSync(dir)) if (/^omp-vcc-core-[0-9a-f]+$/.test(f) && join(dir, f) !== path) rmSync(join(dir, f), { force: true });
        building = undefined;
      } else {
        rmSync(out, { force: true });
        building = { state: "failed", why: stderr.trim().split("\n").slice(-5).join("\n") || `sbcl exited with ${code}` };
      }
    } finally {
      rmSync(lock, { force: true });
    }
  });
  child.on("error", (err) => {
    rmSync(lock, { force: true });
    building = { state: "failed", why: err.message };
  });
  child.unref();
  return { state: "building" };
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
  if (typeof reply.aborted === "string") {
    return { result: { hits: [], totalBeforeCap: 0, truncated: false, aborted: reply.aborted }, searched: reply.searched as number };
  }
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
