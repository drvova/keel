// What /omp-vcc makes of its text, and what the hook reads back from a
// compaction's customInstructions (the core's op args; src/core/compact-args.ts for the command):
// keep:N first or last, the rest a prompt to send after; the marker says the
// pass is the command's.
import { describe, expect, it } from "bun:test";
import { commandArgs } from "../src/core/compact-args";
import { core } from "../src/core/lisp-core";
import { COMPACT_INSTRUCTION as M } from "./support/names";

/** A compaction's customInstructions as the core reads them for op compact. */
const parseInstructions = (customInstructions?: string) => {
  const reply = core({ op: "args", instructions: customInstructions ?? null });
  return { fromCommand: reply.fromCommand === true, keepUserTurns: reply.keepUserTurns as number | null, followUpPrompt: reply.followUpPrompt as string | null };
};

describe("the command's text", () => {
  it.each([
    [undefined, "", null],
    ["", "", null],
    ["keep:3", "", 3],
    ["  keep:3  ", "", 3],
    ["keep:0", "", 0],
    ["keep:2 then run the tests", "then run the tests", 2],
    ["summarize the auth work keep:5", "summarize the auth work", 5],
    // Only first or last: one in between is part of the prompt.
    ["fix keep:2 now", "fix keep:2 now", null],
    ["KEEP:3", "KEEP:3", null],
    ["keep:３", "keep:３", null],
    ["keep:-1", "keep:-1", null],
    ["keep:", "keep:", null],
    ["keep:2keep:3", "keep:2keep:3", null],
    // Any whitespace JavaScript trims and splits on.
    ["then keep:4", "then", 4],
    ["keep:1 and go", "and go", 1],
    // More digits than a safe integer keep as many turns as any session has.
    [`keep:${"9".repeat(30)}`, "", 9007199254740991],
  ])("%j is the prompt %j and keep %j", (text, prompt, keep) => {
    expect(commandArgs(text)).toEqual({ followUpPrompt: prompt, keepUserTurns: keep, instructions: keep === null ? M : `${M} keep:${keep}` });
  });
});

describe("the instructions the hook reads", () => {
  it("knows the command's pass by its marker, and keep:N after it", () => {
    expect(parseInstructions(M)).toEqual({ fromCommand: true, keepUserTurns: null, followUpPrompt: null });
    expect(parseInstructions(`${M} keep:2`)).toEqual({ fromCommand: true, keepUserTurns: 2, followUpPrompt: null });
    expect(parseInstructions(`${M} hello`)).toEqual({ fromCommand: true, keepUserTurns: null, followUpPrompt: null });
  });

  it("reads /compact's text as its keep:N and a prompt to send after", () => {
    expect(parseInstructions(undefined)).toEqual({ fromCommand: false, keepUserTurns: null, followUpPrompt: null });
    expect(parseInstructions("keep:2 then run the tests")).toEqual({ fromCommand: false, keepUserTurns: 2, followUpPrompt: "then run the tests" });
    // The marker only when it stands alone or before a space: anything else is /compact text.
    for (const text of [`${M}keep:4`, "__omp_vcc", `  ${M}\tkeep:5 and more`]) {
      expect(parseInstructions(text)).toEqual({ fromCommand: false, keepUserTurns: null, followUpPrompt: text.trim() });
    }
  });
});
