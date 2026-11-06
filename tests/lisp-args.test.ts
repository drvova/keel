// The Lisp core's reading of compaction arguments (lisp/src/args.lisp, op args)
// against src/core/compact-args.ts: generated /omp-vcc and /compact texts and
// the customInstructions the hook reads (the marker and its look-alikes,
// keep:N first, last, in between or malformed, digits past a safe integer, every
// kind of whitespace JavaScript trims and splits on). Skips without SBCL.
import { describe, expect, it } from "bun:test";
import { commandArgs, OMP_VCC_COMPACT_INSTRUCTION, parseInstructions } from "../src/core/compact-args";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const SPACES = [" ", " ", "  ", "\t", "\n", "\r\n", " ", " ", "﻿", "　", "​", "\u0085"];
const PIECES = [
  "keep:3", "keep:0", "keep:12", "keep:", "keep:-1", "KEEP:3", "keep:３", "keep:3x", "keep:007", `keep:${"9".repeat(30)}`, "keep:9007199254740993",
  "summarize", "the auth work", "then run the tests", "café", "🎉", "keep:2keep:3", OMP_VCC_COMPACT_INSTRUCTION, `${OMP_VCC_COMPACT_INSTRUCTION}keep:4`, "__omp_vcc", "",
];

const text = (r: () => number): string => {
  const n = Math.floor(r() * 6);
  let out = r() < 0.3 ? pick(r, SPACES) : "";
  for (let i = 0; i < n; i++) out += (i ? pick(r, SPACES) : "") + pick(r, PIECES);
  return out + (r() < 0.3 ? pick(r, SPACES) : "");
};

maybe("Lisp core compaction arguments", () => {
  it("reads generated command texts and customInstructions as compact-args.ts does", () => {
    const inputs: Array<string | undefined> = [undefined, "", " ", OMP_VCC_COMPACT_INSTRUCTION, `${OMP_VCC_COMPACT_INSTRUCTION} keep:2`, `  ${OMP_VCC_COMPACT_INSTRUCTION}\tkeep:5 and more`];
    const r = rng(17);
    for (let i = 0; i < 600; i++) {
      const t = text(r);
      inputs.push(t, r() < 0.4 ? `${OMP_VCC_COMPACT_INSTRUCTION}${pick(r, SPACES)}${t}` : t);
    }
    let kept = 0;
    let marked = 0;
    for (const input of inputs) {
      const ts = { command: withCore(undefined, () => commandArgs(input)), hook: withCore(undefined, () => parseInstructions(input)) };
      const lisp = { command: withCore(core, () => commandArgs(input)), hook: withCore(core, () => parseInstructions(input)) };
      expect({ input, ...lisp }).toEqual({ input, ...ts });
      if (ts.command.keepUserTurns !== null) kept++;
      if (ts.hook.fromCommand) marked++;
    }
    expect(kept).toBeGreaterThan(200);
    expect(marked).toBeGreaterThan(60);
  }, 180_000);
});
