// Where keel's core comes from (src/core.ts): KEEL_CORE when it
// names one, else the build of this copy's sources with
// the user's SBCL, named by their hash; without SBCL it says so.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCoreNow, coreStatus } from "../src/core";

const saved = { core: process.env.KEEL_CORE, sbcl: process.env.SBCL, dir: process.env.KEEL_CORE_BUILD_DIR };
afterEach(() => {
  if (process.env.KEEL_CORE_BUILD_DIR !== saved.dir) rmSync(process.env.KEEL_CORE_BUILD_DIR!, { recursive: true, force: true });
  for (const [k, v] of [["KEEL_CORE", saved.core], ["SBCL", saved.sbcl], ["KEEL_CORE_BUILD_DIR", saved.dir]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the core's source", () => {
  it("is the executable KEEL_CORE names", () => {
    process.env.KEEL_CORE = "/opt/keel-core";
    expect(coreStatus()).toEqual({ state: "ready", path: "/opt/keel-core" });
  });

  it.skipIf(!buildCoreNow())("builds this copy's sources with SBCL, under a name their hash gives", async () => {
    delete process.env.KEEL_CORE;
    let s = coreStatus();
    for (let i = 0; i < 120 && s.state === "building"; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      s = coreStatus();
    }
    expect(s.state).toBe("ready");
    if (s.state === "ready") expect(s.path).toMatch(/lisp\/build\/keel-core-[0-9a-f]{16}$/);
  }, 180_000);

  // Last: "no SBCL" is the answer for a minute, which would keep the build above from starting.
  it("says SBCL is missing when it cannot build one", () => {
    delete process.env.KEEL_CORE;
    process.env.SBCL = "/nonexistent/sbcl";
    // An empty build directory: no earlier build of these sources to fall back on.
    process.env.KEEL_CORE_BUILD_DIR = mkdtempSync(join(tmpdir(), "keel-no-build-"));
    expect(coreStatus()).toEqual({ state: "no-sbcl", sbcl: "/nonexistent/sbcl" });
  });
});
