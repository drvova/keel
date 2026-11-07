import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
 * fails throws too: it is all there is.
 */
export const core = (request: object): Record<string, unknown> => {
  const status = coreStatus();
  if (status.state !== "ready") throw new CoreUnavailable(status);
  const run = spawnSync(status.path, [], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 30 });
  let reply: any;
  try { reply = run.error || run.status !== 0 ? undefined : JSON.parse(run.stdout); } catch {}
  if (reply?.ok === true) return reply;
  throw new Error(`omp-vcc's core failed: ${reply?.error ?? run.error?.message ?? (run.stderr || `exit ${run.status}`)}`);
};

/** The core cannot answer yet, or here: `message` says why, as a user is told. */
export class CoreUnavailable extends Error {
  constructor(readonly status: Exclude<CoreStatus, { state: "ready" }>) {
    super(coreUnavailableText(status));
  }
}

const coreUnavailableText = (status: CoreUnavailable["status"]): string => {
  switch (status.state) {
    case "building": return "omp-vcc is building its core, once for this version (a few seconds); until then it steps aside.";
    case "no-sbcl": return `omp-vcc needs SBCL to build its core and found none (${status.sbcl}): install SBCL (apt install sbcl, brew install sbcl, or sbcl.org) and omp-vcc tries again within a minute, or set SBCL to its path and start a new session; until then it steps aside.`;
    case "failed": return `omp-vcc could not build its core with SBCL (it tries again within a minute): ${status.why}`;
  }
};

/** Where the core stands: ready at a path, being built, or not buildable here (and why). */
export type CoreStatus =
  | { state: "ready"; path: string }
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

/** A core that could not be built is tried again after this: SBCL may have been installed since, or a full disk freed. */
const RETRY_MS = 60_000;
/** This process is building the core (one build per installed copy, shared by every binding). */
let ownBuild = false;
/** Why the last try could not build the core, and when: until RETRY_MS later, the answer. */
let lastFailure: { status: Exclude<CoreStatus, { state: "ready" | "building" }>; at: number } | undefined;

/** The core's state now; starts the build when it is neither there nor being built. */
export const coreStatus = (): CoreStatus => {
  const named = process.env.OMP_VCC_CORE;
  if (named) return { state: "ready", path: named };
  const { path } = buildOfSources();
  if (existsSync(path)) return { state: "ready", path };
  if (ownBuild) return { state: "building" };
  if (lastFailure && Date.now() - lastFailure.at < RETRY_MS) return lastFailure.status;
  lastFailure = undefined;
  return startBuild(path);
};

const failed = (status: Exclude<CoreStatus, { state: "ready" | "building" }>): CoreStatus => {
  lastFailure = { status, at: Date.now() };
  return status;
};

/** What builds the core: build.lisp, writing the executable where OMP_VCC_CORE_OUT says. */
const BUILD_ARGS = ["--noinform", "--non-interactive", "--load", join(LISP_DIR, "build.lisp")];
const hasSbcl = (sbcl: string): boolean => spawnSync(sbcl, ["--version"], { stdio: "ignore" }).status === 0;

/** A finished build OUT installed as PATH, the builds of older sources removed. */
const install = (out: string, path: string): void => {
  renameSync(out, path);
  const dir = buildDir();
  for (const f of readdirSync(dir)) if (/^omp-vcc-core-[0-9a-f]+$/.test(f) && join(dir, f) !== path) rmSync(join(dir, f), { force: true });
};

/**
 * The build of these sources, built now when it is not there, for a test run
 * or a script that cannot wait for the background build: its path, or
 * undefined without SBCL. A failed build throws, with SBCL's output.
 */
export const buildCoreNow = (): string | undefined => {
  const { path } = buildOfSources();
  if (existsSync(path)) return path;
  const sbcl = process.env.SBCL ?? "sbcl";
  if (!hasSbcl(sbcl)) return undefined;
  mkdirSync(buildDir(), { recursive: true });
  const out = `${path}.tmp-${process.pid}`;
  const run = spawnSync(sbcl, BUILD_ARGS, { env: { ...process.env, OMP_VCC_CORE_OUT: out }, encoding: "utf8" });
  if (run.status !== 0 || !existsSync(out)) {
    rmSync(out, { force: true });
    throw new Error(`omp-vcc's core did not build:\n${run.stdout}\n${run.stderr}`);
  }
  install(out, path);
  return path;
};

const startBuild = (path: string): CoreStatus => {
  // Another process (another omp or Pi session) may be building it already.
  const lock = `${path}.lock`;
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return { state: "building" };
  const sbcl = process.env.SBCL ?? "sbcl";
  if (!hasSbcl(sbcl)) return failed({ state: "no-sbcl", sbcl });
  mkdirSync(buildDir(), { recursive: true });
  try {
    rmSync(lock, { force: true });
    closeSync(openSync(lock, "wx"));
  } catch {
    return { state: "building" };
  }
  ownBuild = true;
  const out = `${path}.tmp-${process.pid}`;
  let stderr = "";
  const child = spawn(sbcl, BUILD_ARGS, {
    env: { ...process.env, OMP_VCC_CORE_OUT: out },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.stderr?.on("data", (d) => { stderr = (stderr + String(d)).slice(-2_000); });
  child.on("exit", (code) => {
    try {
      if (code === 0 && existsSync(out)) {
        install(out, path);
      } else {
        rmSync(out, { force: true });
        failed({ state: "failed", why: stderr.trim().split("\n").slice(-5).join("\n") || `sbcl exited with ${code}` });
      }
    } finally {
      ownBuild = false;
      rmSync(lock, { force: true });
    }
  });
  child.on("error", (err) => {
    ownBuild = false;
    rmSync(lock, { force: true });
    failed({ state: "failed", why: err.message });
  });
  child.unref();
  return { state: "building" };
};
