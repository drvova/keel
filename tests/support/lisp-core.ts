// The Lisp core's executable for tests: built from lisp/ with the `sbcl` on PATH
// (or SBCL), once per process; undefined where there is no SBCL.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const LISP = join(ROOT, "lisp");
const CORE = join(LISP, "build", "omp-vcc-core");

const newestSource = (dir: string): number =>
  Math.max(...readdirSync(dir, { withFileTypes: true }).map((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "build" ? 0 : newestSource(p);
    return /\.(lisp|asd)$/.test(d.name) ? statSync(p).mtimeMs : 0;
  }));

let built: string | undefined | null = null;

export const lispCore = (): string | undefined => {
  if (built !== null) return built;
  const sbcl = process.env.SBCL ?? "sbcl";
  if (spawnSync(sbcl, ["--version"]).status !== 0) return (built = undefined);
  if (!existsSync(CORE) || statSync(CORE).mtimeMs < newestSource(LISP)) {
    const run = spawnSync(sbcl, ["--noinform", "--non-interactive", "--load", join(LISP, "build.lisp")], { encoding: "utf8" });
    if (run.status !== 0 || !existsSync(CORE)) throw new Error(`lisp core build failed:\n${run.stdout}\n${run.stderr}`);
  }
  return (built = CORE);
};

/** Run `fn`, awaiting it, with OMP_VCC_CORE naming `core` (a traced one, say), then put back what was there. */
export const withCoreAt = async <T>(core: string, fn: () => Promise<T>): Promise<T> => {
  const was = process.env.OMP_VCC_CORE;
  process.env.OMP_VCC_CORE = core;
  try { return await fn(); } finally {
    if (was === undefined) delete process.env.OMP_VCC_CORE;
    else process.env.OMP_VCC_CORE = was;
  }
};

/** The core behind a script that logs each start to `dir`, and how many starts there were. */
export const tracedCore = (core: string, dir: string): { path: string; starts: () => number } => {
  const log = join(dir, "core-starts.log");
  const path = join(dir, "omp-vcc-core-traced");
  writeFileSync(path, `#!/bin/sh\necho start >> '${log}'\nexec '${core}' "$@"\n`);
  chmodSync(path, 0o755);
  writeFileSync(log, "");
  return { path, starts: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length };
};
