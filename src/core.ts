import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Lisp core (lisp/): one JSON request in, one response out
 * (lisp/src/server.lisp). Where the system has named pipes, one core process
 * stays up for this host process and answers every request (`--serve`,
 * lisp/src/live.lisp), so a session file it read is kept parsed for the next
 * request; elsewhere, or when that process cannot start or dies, each request
 * runs its own process with spawnSync (a start costs ~5 ms). Either way the
 * callers stay synchronous.
 *
 * Which executable: KEEL_CORE when it names one, else the build of this
 * copy's lisp/ sources, lisp/build/keel-core-<hash of the sources> (or in
 * KEEL_CORE_BUILD_DIR), which
 * keel builds itself with the user's SBCL the first time it is needed (in
 * the background, a few seconds; an update of the sources builds again).
 *
 * While it is not there (being built, no SBCL, a failed build) a call throws
 * CoreUnavailable, which says why in words a user can act on; each surface
 * catches it and steps aside or tells (whenCore, below). A core that
 * fails throws too: it is all there is.
 */
export const core = (request: object): Record<string, unknown> => {
  const status = coreStatus();
  if (status.state !== "ready") throw new CoreUnavailable(status);
  const input = JSON.stringify(request);
  const answered = liveAnswer(status.path, input);
  if (answered !== undefined) return replyOf(answered, answered.slice(0, 500));
  const run = spawnSync(status.path, [], { input, encoding: "utf8", maxBuffer: 1 << 30 });
  return replyOf(run.error || run.status !== 0 ? undefined : run.stdout, run.error?.message ?? (run.stderr || `exit ${run.status}`));
};

/** The core's answer in TEXT, or an error with its own reason, else WHY. */
const replyOf = (text: string | undefined, why: string): Record<string, unknown> => {
  let reply: any;
  try { reply = text === undefined ? undefined : JSON.parse(text); } catch {}
  if (reply?.ok === true) return reply;
  throw new Error(`keel's core failed: ${reply?.error ?? why}`);
};

// --- the live core ----------------------------------------------------------------

/** The core process this host process keeps, and its pipes (lisp/src/live.lisp). */
interface Live { path: string; child: ReturnType<typeof spawn>; dir: string; req: number; resp: number; pending: Buffer }
let live: Live | undefined;
/** A live core that would not start is not tried again before this, for this executable. */
let liveRefused: { path: string; at: number } | undefined;
const LIVE_RETRY_MS = 60_000;
/** How long a live core may take to start, and to answer (it answers a request past 55 s as failed itself). */
const LIVE_START_MS = 5_000;
const LIVE_ANSWER_MS = 120_000;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

/** KEEL_<NAME>, or OMP_VCC_<NAME> as keel read it under its earlier name. */
const env = (name: string): string | undefined => process.env[`KEEL_${name}`] ?? process.env[`OMP_VCC_${name}`];

/** Whether this host process runs one core for every request: not on Windows (no named pipes there), not with KEEL_CORE_LIVE=off. */
const liveWanted = () => process.platform !== "win32" && env("CORE_LIVE") !== "off";

const stopLive = () => {
  if (!live) return;
  const l = live;
  live = undefined;
  for (const fd of [l.req, l.resp]) try { if (fd >= 0) closeSync(fd); } catch {}
  try { l.child.kill(); } catch {}
  rmSync(l.dir, { recursive: true, force: true });
};
process.once("exit", stopLive);

/**
 * One line from the core's response pipe, or undefined when it ended or the
 * deadline passed. While STARTING, the core may not have opened the pipe for
 * writing yet, which reads as its end too: waited out.
 */
const readLine = (l: Live, deadline: number, starting = false): string | undefined => {
  const chunk = Buffer.allocUnsafe(1 << 20);
  for (let idle = 0; ; ) {
    const nl = l.pending.indexOf(10);
    if (nl >= 0) {
      const line = l.pending.subarray(0, nl).toString("utf8");
      l.pending = l.pending.subarray(nl + 1);
      return line;
    }
    let n: number;
    try { n = readSync(l.resp, chunk, 0, chunk.length, null); } catch (e) {
      if (code(e) !== "EAGAIN") return undefined;
      if (Date.now() > deadline) return undefined;
      // Most answers take a millisecond or two: spin briefly before sleeping.
      if (++idle > 50) sleep(1);
      continue;
    }
    if (n === 0) {
      if (!starting || Date.now() > deadline || l.child.exitCode !== null) return undefined; // the core is gone
      sleep(2);
      continue;
    }
    idle = 0;
    l.pending = Buffer.concat([l.pending, chunk.subarray(0, n)]);
  }
};

const writeAll = (fd: number, bytes: Buffer, deadline: number): boolean => {
  for (let at = 0; at < bytes.length; ) {
    try { at += writeSync(fd, bytes, at, bytes.length - at); } catch (e) {
      if (code(e) !== "EAGAIN" || Date.now() > deadline) return false;
      sleep(1);
    }
  }
  return true;
};

/** The live core for PATH, started when there is none (or it is another build's): undefined when it cannot run here. */
const liveCore = (path: string): Live | undefined => {
  if (live && live.path === path && live.child.exitCode === null && live.child.signalCode === null) return live;
  stopLive();
  if (liveRefused && liveRefused.path === path && Date.now() - liveRefused.at < LIVE_RETRY_MS) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "keel-core-"));
  const child = spawn(path, ["--serve", dir], { stdio: "ignore" });
  child.unref();
  child.on("error", () => {});
  const l: Live = { path, child, dir, req: -1, resp: -1, pending: Buffer.alloc(0) };
  live = l;
  const deadline = Date.now() + LIVE_START_MS;
  // The core makes the pipes; the response pipe is opened without waiting, so the core's open of it returns.
  while (l.resp < 0 && Date.now() < deadline && child.exitCode === null) {
    try { l.resp = openSync(join(dir, "resp"), constants.O_RDONLY | constants.O_NONBLOCK); } catch { sleep(2); }
  }
  const ready = l.resp >= 0 ? readLine(l, deadline, true) : undefined;
  if (ready === "ready") try { l.req = openSync(join(dir, "req"), constants.O_WRONLY | constants.O_NONBLOCK); } catch {}
  if (l.req < 0) {
    stopLive();
    liveRefused = { path, at: Date.now() };
    return undefined;
  }
  return l;
};

/** INPUT answered by the live core (its response line), or undefined when there is none here or it failed to answer: the caller runs the request on its own. */
const liveAnswer = (path: string, input: string): string | undefined => {
  if (!liveWanted()) return undefined;
  const l = liveCore(path);
  if (!l) return undefined;
  const deadline = Date.now() + LIVE_ANSWER_MS;
  const line = writeAll(l.req, Buffer.from(`${input}\n`, "utf8"), deadline) ? readLine(l, deadline) : undefined;
  if (line === undefined) stopLive();
  return line;
};

/** The live core's process id, for the tests. */
export const liveCorePid = (): number | undefined => live?.child.pid;

/** The core cannot answer yet, or here: `message` says why, as a user is told. */
export class CoreUnavailable extends Error {
  constructor(readonly status: Exclude<CoreStatus, { state: "ready" }>) {
    super(coreUnavailableText(status));
  }
}

const coreUnavailableText = (status: CoreUnavailable["status"]): string => {
  switch (status.state) {
    case "building": return "keel is building its core, once for this version (a few seconds); until then it steps aside.";
    case "no-sbcl": return `keel needs SBCL to build its core and found none (${status.sbcl}): install SBCL (apt install sbcl, brew install sbcl, or sbcl.org) and keel tries again within a minute, or set SBCL to its path and start a new session; until then it steps aside.`;
    case "failed": return `keel could not build its core with SBCL (it tries again within a minute): ${status.why}`;
  }
};

/** Where the core stands: ready at a path, being built, or not buildable here (and why). */
export type CoreStatus =
  | { state: "ready"; path: string }
  | { state: "building" }
  | { state: "no-sbcl"; sbcl: string }
  | { state: "failed"; why: string };

const LISP_DIR = fileURLToPath(new URL("../lisp/", import.meta.url));
/** Where builds go: lisp/build, or KEEL_CORE_BUILD_DIR (an install whose own directory is read-only). */
const buildDir = (): string => env("CORE_BUILD_DIR") || join(LISP_DIR, "build");
/** A lock older than this is a build that died with its process: built again. */
const STALE_LOCK_MS = 15 * 60_000;

/** The sources the core is built from: the system, its src files and build.lisp (not its tests or the lint). */
const sourceFiles = (dir: string): string[] =>
  [join(dir, "keel-core.asd"), join(dir, "build.lisp"),
   ...readdirSync(join(dir, "src")).filter((f) => f.endsWith(".lisp")).map((f) => join(dir, "src", f))].sort();

let sourcesHash: string | undefined;
/** The build of these sources: its path is named by their hash, so an update builds again. */
const buildOfSources = (): { hash: string; path: string } => {
  if (!sourcesHash) {
    const h = createHash("sha256");
    for (const f of sourceFiles(LISP_DIR)) h.update(relative(LISP_DIR, f)).update("\0").update(readFileSync(f)).update("\0");
    sourcesHash = h.digest("hex").slice(0, 16);
  }
  // Windows runs no executable without `.exe`.
  const ext = process.platform === "win32" ? ".exe" : "";
  return { hash: sourcesHash, path: join(buildDir(), `keel-core-${sourcesHash}${ext}`) };
};

/** A core that could not be built is tried again after this: SBCL may have been installed since, or a full disk freed. */
const RETRY_MS = 60_000;
/** This process is building the core (one build per installed copy, shared by every binding). */
let ownBuild = false;
/** Why the last try could not build the core, and when: until RETRY_MS later, the answer. */
let lastFailure: { status: Exclude<CoreStatus, { state: "ready" | "building" }>; at: number } | undefined;

/** The core's state now; starts the build when it is neither there nor being built. */
export const coreStatus = (): CoreStatus => {
  const named = env("CORE");
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

/** What builds the core: build.lisp, writing the executable where KEEL_CORE_OUT says. */
const BUILD_ARGS = ["--noinform", "--non-interactive", "--load", join(LISP_DIR, "build.lisp")];
const sbclPath = () => process.env.SBCL ?? "sbcl";
const hasSbcl = (sbcl: string): boolean => spawnSync(sbcl, ["--version"], { stdio: "ignore" }).status === 0;
/** Where a build of PATH by this process writes, and the env that says so. */
const buildTarget = (path: string) => {
  mkdirSync(buildDir(), { recursive: true });
  const out = `${path}.tmp-${process.pid}`;
  return { out, env: { ...process.env, KEEL_CORE_OUT: out } };
};

/** A finished build OUT installed as PATH, the builds of older sources removed. */
const install = (out: string, path: string): void => {
  renameSync(out, path);
  const dir = buildDir();
  for (const f of readdirSync(dir)) if (/^keel-core-[0-9a-f]+(\.exe)?$/.test(f) && join(dir, f) !== path) rmSync(join(dir, f), { force: true });
};

/**
 * The build of these sources, built now when it is not there, for a test run
 * or a script that cannot wait for the background build: its path, or
 * undefined without SBCL. A failed build throws, with SBCL's output.
 */
export const buildCoreNow = (): string | undefined => {
  const { path } = buildOfSources();
  if (existsSync(path)) return path;
  const sbcl = sbclPath();
  if (!hasSbcl(sbcl)) return undefined;
  const { out, env } = buildTarget(path);
  const run = spawnSync(sbcl, BUILD_ARGS, { env, encoding: "utf8" });
  if (run.status !== 0 || !existsSync(out)) {
    rmSync(out, { force: true });
    throw new Error(`keel's core did not build:\n${run.stdout}\n${run.stderr}`);
  }
  install(out, path);
  return path;
};

const startBuild = (path: string): CoreStatus => {
  // Another process (another omp or Pi session) may be building it already.
  const lock = `${path}.lock`;
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return { state: "building" };
  const sbcl = sbclPath();
  if (!hasSbcl(sbcl)) return failed({ state: "no-sbcl", sbcl });
  const { out, env } = buildTarget(path);
  try {
    rmSync(lock, { force: true });
    closeSync(openSync(lock, "wx"));
  } catch {
    return { state: "building" };
  }
  ownBuild = true;
  let stderr = "";
  const child = spawn(sbcl, BUILD_ARGS, {
    env,
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

/** Run `run`; while the core is not there, hand its reason to `waiting` and give back undefined. A core that fails throws. */
export const whenCore = <T>(run: () => T, waiting: (why: string) => void = () => {}): T | undefined => {
  try {
    return run();
  } catch (err) {
    if (err instanceof CoreUnavailable) {
      waiting(err.message);
      return undefined;
    }
    throw err;
  }
};
