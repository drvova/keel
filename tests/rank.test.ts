// The brief's ranking (lisp/src/brief.lisp): which blocks the brief keeps
// when it cannot keep them all, and the char budget it keeps them within.
import { describe, expect, it } from "bun:test";
import { compile as compileAt, type CompileInput } from "../src/core/summarize";
import { DEFAULT_SUMMARY_LIMITS } from "./support/window";
import type { NormalizedBlock } from "../src/types";
import { assistantText, assistantWithToolCall, userMsg } from "./fixtures";
import { summarize } from "./support/summary";
/** compile at a ~128K window's section limits unless a test sets its own. */
const compile = (input: Omit<CompileInput, "limits"> & { limits?: CompileInput["limits"] }) => compileAt({ limits: DEFAULT_SUMMARY_LIMITS, ...input });

const briefPart = (summary: string): string => summary.split("\n\n---\n\n")[1] ?? "";
/** The brief of these blocks under RANKING. */
const briefUnder = (blocks: NormalizedBlock[], ranking: NonNullable<CompileInput["ranking"]>): string => summarize(blocks, { ranking }).state.brief;
/** Whether the brief, keeping one block of A then B, keeps A: A outranks B although B is the newer. */
const outranks = (a: NormalizedBlock, b: NormalizedBlock, aText: string, bText: string): boolean => {
  const brief = briefUnder([a, b], { maxBlocks: 1, preserveRecentBlocks: 0 });
  return brief.includes(aText) && !brief.includes(bText);
};
const call = (name: string, args: Record<string, unknown>): NormalizedBlock => ({ kind: "tool_call", name, args });
const userRan = (command: string, exitCode = 0): NormalizedBlock => ({ kind: "bash", command, exitCode });

describe("brief ranking", () => {
  it("ranks an edit and a test run above a read and another command", () => {
    for (const [plain, text] of [[call("Read", { file_path: "src/other.ts" }), "src/other.ts"], [call("bash", { command: "du -sh dist" }), "du -sh dist"]] as const) {
      expect(outranks(call("Edit", { file_path: "src/auth.ts" }), plain, "src/auth.ts", text)).toBe(true);
      expect(outranks(call("bash", { command: "bun test tests/auth.test.ts" }), plain, "bun test", text)).toBe(true);
    }
  });

  it("ranks scaffolding-only bash below substantive commands", () => {
    // The same preamble in front of real work is no penalty.
    expect(outranks(userRan("set -euo pipefail\nmake dist"), userRan("set -euo pipefail\ncd /tmp/proj\nls -la"), "make dist", "/tmp/proj")).toBe(true);
  });

  it("does not take a real command after a stray '<<' with no terminator for a heredoc's body", () => {
    // `<<NOTE` has no closing `NOTE` line, so the git commit below it is work, not a skipped body.
    expect(outranks(userRan("echo \"see <<NOTE for details\"\ngit commit -m fix"), userRan("echo hi\ncd /tmp/proj"), "git commit", "/tmp/proj")).toBe(true);
  });

  it("does not penalize a scaffolding command that failed (nonzero exit is a real fact)", () => {
    expect(outranks(userRan("cd /tmp/missing", 1), userRan("make dist"), "/tmp/missing", "make dist")).toBe(true);
  });

  it("ranks a failed call above the same call that passed", () => {
    const run = (failed: boolean, id: string): NormalizedBlock => ({ kind: "tool_call", name: "bash", args: { command: failed ? "make dist" : "make dist " }, id, failed });
    const brief = briefUnder([run(true, "a"), run(false, "b")], { maxBlocks: 1, preserveRecentBlocks: 0 });
    expect(brief).toContain("make dist");
    expect(brief).toMatch(/fail/i);
  });

  it("keeps the blocks it selects in their order", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { file_path: "noise-a.ts" } },
      { kind: "tool_call", name: "Read", args: { file_path: "noise-b.ts" } },
      { kind: "user", text: "Fix auth bug" },
      { kind: "assistant", text: "Root cause is stale token refresh." },
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" } },
      { kind: "tool_call", name: "bash", args: { command: "bun test tests/auth.test.ts" } },
    ];
    const brief = briefUnder(blocks, { maxBlocks: 4, preserveRecentBlocks: 1 });
    expect(brief).not.toContain("noise-");
    const at = ["Fix auth bug", "Root cause", "src/auth.ts", "bun test"].map((t) => brief.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });

  it("keeps a non-trivial assistant turn that closes a user segment over one that does not", () => {
    // The same report twice: once closing the first request, once followed by more work.
    const report = (n: number) => `Report ${n}: implemented the auth fix, verified the focused auth test, confirmed the changed file is limited to src/auth.ts, and no blockers remain.`;
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix auth bug" },
      { kind: "assistant", text: report(1) },
      { kind: "user", text: "ok next" },
      { kind: "assistant", text: report(2) },
      call("Read", { file_path: "noise-a.ts" }),
    ];
    // Room for two blocks: the report that closed its request is one of them, although it is the older.
    const brief = briefUnder(blocks, { maxBlocks: 2, preserveRecentBlocks: 0 });
    expect(brief).toContain("Report 1:");
    expect(brief).not.toContain("Report 2:");
  });

  it("does not spend ranked selection budget on tool results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix auth bug" },
      { kind: "assistant", text: "Root cause is stale token refresh." },
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" } },
      { kind: "tool_result", name: "Edit", text: "large hidden tool output".repeat(200) },
      { kind: "tool_result", name: "bash", text: "more hidden output".repeat(200) },
    ];
    const brief = briefUnder(blocks, { maxBlocks: 4, preserveRecentBlocks: 2 });
    for (const kept of ["Fix auth bug", "Root cause", "src/auth.ts"]) expect(brief).toContain(kept);
    expect(brief).not.toContain("large hidden tool output".repeat(3));
    expect(brief).not.toContain("more hidden output".repeat(3));
  });

  it("deduplicates repeated gh PR polling commands", () => {
    // One block more than maxBlocks, so the selection ranks; both polls outscore the read.
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { file_path: "notes.md" } },
      { kind: "user", text: "Merge PR 123 when green" },
      { kind: "tool_call", name: "bash", args: { command: "gh pr view 123 --json mergeStateStatus" } },
      { kind: "tool_call", name: "bash", args: { command: "gh pr checks 123 --watch" } },
      { kind: "tool_call", name: "bash", args: { command: "gh pr merge 123 --squash --delete-branch" } },
    ];
    const brief = briefUnder(blocks, { maxBlocks: 4, preserveRecentBlocks: 0 });
    expect((brief.match(/gh pr (?:view|checks) 123/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(brief).toContain("gh pr merge 123");
  });

  it("compile reduces brief noise while keeping semantic sections from all blocks", () => {
    const exploration = Array.from({ length: 15 }, (_, i) => [
      userMsg(`look around ${i}`),
      assistantWithToolCall("Read", { file_path: `noise${i}.ts` }),
    ]).flat();
    const critical = [
      userMsg("Fix auth bug"),
      assistantText("Root cause is stale token refresh."),
      assistantWithToolCall("Edit", { file_path: "src/auth.ts" }),
      assistantWithToolCall("bash", { command: "bun test tests/auth.test.ts" }),
      assistantText("Fixed auth bug and tests passed."),
    ];

    const baseline = compile({ messages: [...exploration, ...critical] });
    const ranked = compile({
      messages: [...exploration, ...critical],
      ranking: { maxBlocks: 10, preserveRecentBlocks: 4 },
    });

    expect(briefPart(ranked).length).toBeLessThan(briefPart(baseline).length);
    expect(briefPart(ranked)).toContain("Fix auth bug");
    expect(briefPart(ranked)).toContain('* Edit "src/auth.ts"');
    expect(briefPart(ranked)).toContain('* bash "bun test tests/auth.test.ts"');
    expect(briefPart(ranked)).not.toContain('Read "noise');
    // The sections still come from every block, the ones the brief left out too.
    const header = ranked.slice(0, ranked.indexOf("\n\n---\n\n"));
    expect(header).toContain("[Early Session Requests]\n- look around 0\n");
    expect(header).toContain("noise14.ts");
  });

  it("keeps fresh ranked brief and gives previous brief the remaining budget", () => {
    const previousBrief = Array.from({ length: 200 }, (_, i) => `[user]\nold context ${i}`).join("\n\n");
    const previousSummary = `[Early Session Requests]\n- Original goal\n\n---\n\n${previousBrief}`;
    const ranked = compile({
      previousSummary,
      messages: [
        userMsg("Fix fresh ranked bug"),
        assistantText("Fresh ranked root cause should survive merge."),
        assistantWithToolCall("Edit", { file_path: "src/fresh.ts" }),
        assistantWithToolCall("bash", { command: "bun test tests/fresh.test.ts" }),
        assistantText("Fresh ranked fix passed tests."),
      ],
      ranking: { maxBlocks: 5, preserveRecentBlocks: 2 },
    });

    expect(ranked).toContain("Fresh ranked root cause should survive merge.");
    expect(ranked).toContain('* Edit "src/fresh.ts"');
    expect(ranked).toContain('* bash "bun test tests/fresh.test.ts"');
    expect(ranked).toContain("Fresh ranked fix passed tests.");
    expect(ranked).toContain("old context 199");
    expect(ranked).not.toContain("old context 0");
  });

  it("charges preserve-recent blocks against the char budget so large recent runs cannot blow past it", () => {
    // Regression: on very long transcripts the newest blocks alone could exceed
    // maxBriefChars because preserve-recent was added unconditionally. They are
    // charged against the budget (newest first) and skipped once it is full.
    const blocks: NormalizedBlock[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "assistant" as const,
      text: `recent block ${i} ` + "x".repeat(1200),
    }));
    const maxBriefChars = 3000;
    // Ask to preserve every block.
    const brief = briefUnder(blocks, { maxBlocks: 80, preserveRecentBlocks: 8, maxBriefChars });
    // The budget is a true ceiling even though every candidate is a recent block.
    expect(brief.length).toBeLessThanOrEqual(maxBriefChars);
    // The newest block is kept, and the oldest is not: not everything fits.
    expect(brief).toContain("recent block 7");
    expect(brief).not.toContain("recent block 0");
  });

  it("keeps the ranked brief within the char budget even when recent turns are huge", () => {
    const huge = Array.from({ length: 10 }, (_, i) =>
      assistantText(`huge recent turn ${i} ` + "y".repeat(900)),
    );
    const maxBriefChars = 3000;

    const ranked = compile({
      messages: [userMsg("start a big task"), ...huge],
      ranking: { maxBlocks: 80, preserveRecentBlocks: 10, maxBriefChars },
    });
    const brief = briefPart(ranked);

    // Without the fix this brief would be ~9000+ chars; the budget caps it.
    // Small slack covers the "...omitted" marker and line-wrap newlines.
    expect(brief.length).toBeLessThanOrEqual(maxBriefChars + 400);
    expect(brief.length).toBeGreaterThan(0);
  });

  it("scales the char budget with transcript length between floor and ceiling", () => {
    // Size-relative budget: clamp(briefCharsPerBlock * blockCount, floor, ceiling).
    const mkBlocks = (n: number): NormalizedBlock[] =>
      Array.from({ length: n }, (_, i) => ({ kind: "assistant" as const, text: `block ${i} ` + "x".repeat(300) }));
    const opts = { maxBlocks: 500, preserveRecentBlocks: 0, maxBriefChars: 4400, maxBriefCharsCeiling: 8000, briefCharsPerBlock: 60 };

    // Small transcript (10 blocks -> 600 < floor): pinned at the floor, where all ~3,200 chars fit.
    const small = briefUnder(mkBlocks(10), opts);
    expect(small).toContain("block 0 ");
    expect(small).toContain("block 9 ");

    // Mid transcript (100 blocks -> 6000, between floor and ceiling): exceeds the floor.
    const mid = briefUnder(mkBlocks(100), opts);
    expect(mid.length).toBeGreaterThan(4400);
    expect(mid.length).toBeLessThanOrEqual(6000);

    // Huge transcript (400 blocks -> 24000, clamped): never exceeds the ceiling.
    const huge = briefUnder(mkBlocks(400), opts);
    expect(huge.length).toBeLessThanOrEqual(8000);
    expect(huge.length).toBeGreaterThan(mid.length);
  });

  it("ignores the size-relative ceiling unless slope and floor are both set", () => {
    // Ceiling alone must not change behavior: falls back to the flat maxBriefChars.
    const blocks: NormalizedBlock[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "assistant" as const,
      text: `block ${i} ` + "x".repeat(300),
    }));
    const flat = briefUnder(blocks, { maxBlocks: 500, preserveRecentBlocks: 0, maxBriefChars: 4400 });
    const ceilOnly = briefUnder(blocks, { maxBlocks: 500, preserveRecentBlocks: 0, maxBriefChars: 4400, maxBriefCharsCeiling: 8000 });
    expect(ceilOnly.length).toBe(flat.length);
    expect(flat.length).toBeLessThanOrEqual(4400);
  });
});
