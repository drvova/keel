// The Lisp core's executable for tests: built from lisp/ with the `sbcl` on PATH
// (or SBCL), once per process; undefined where there is no SBCL.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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
