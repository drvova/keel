// Where omp-vcc's core comes from (src/core/lisp-core.ts): OMP_VCC_CORE when it
// names one, off when it says off, else the build of this copy's sources with
// the user's SBCL, named by their hash; without SBCL it says so.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { coreStatus } from "../src/core/lisp-core";
import { lispCore } from "./support/lisp-core";

const saved = { core: process.env.OMP_VCC_CORE, sbcl: process.env.SBCL };
afterEach(() => {
  for (const [k, v] of [["OMP_VCC_CORE", saved.core], ["SBCL", saved.sbcl]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the core's source", () => {
  it("is the executable OMP_VCC_CORE names, or none when it says off", () => {
    process.env.OMP_VCC_CORE = "/opt/omp-vcc-core";
    expect(coreStatus()).toEqual({ state: "ready", path: "/opt/omp-vcc-core" });
    process.env.OMP_VCC_CORE = "off";
    expect(coreStatus()).toEqual({ state: "off" });
  });

  it.skipIf(!lispCore())("builds this copy's sources with SBCL, under a name their hash gives", async () => {
    delete process.env.OMP_VCC_CORE;
    let s = coreStatus();
    for (let i = 0; i < 120 && s.state === "building"; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      s = coreStatus();
    }
    expect(s.state).toBe("ready");
    if (s.state === "ready") expect(s.path).toMatch(/lisp\/build\/omp-vcc-core-[0-9a-f]{16}$/);
  }, 180_000);

  // Last: the state "no SBCL" is kept for the process, which would keep the build above from starting.
  it("says SBCL is missing when it cannot build one", () => {
    delete process.env.OMP_VCC_CORE;
    process.env.SBCL = "/nonexistent/sbcl";
    const s = coreStatus();
    // A build of these sources may exist from an earlier run; else there is no SBCL to make one.
    if (s.state === "ready") expect(existsSync(s.path)).toBe(true);
    else expect(s).toEqual({ state: "no-sbcl", sbcl: "/nonexistent/sbcl" });
  });
});
