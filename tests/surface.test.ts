// The tools and commands keel registers are the core's (lisp/src/surface.lisp);
// src/surface.ts writes them down for the binding, which registers them before
// a core may exist. It must say what the core does: after a change to
// surface.lisp or names.lisp, `bun --preload ./tests/support/core-on.ts scripts/surface.ts`.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { core } from "../src/core";
import { surfaceSource } from "../scripts/surface";

describe("src/surface.ts", () => {
  it("is what the core's surface op answers, as scripts/surface.ts writes it", () => {
    expect(readFileSync(join(import.meta.dir, "../src/surface.ts"), "utf8")).toBe(surfaceSource(core({ op: "surface" }).surface));
  });
});
