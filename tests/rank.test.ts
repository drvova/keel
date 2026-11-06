import { describe, expect, it } from "bun:test";
import { compile as compileAt, type CompileInput } from "../src/core/summarize";
import { DEFAULT_SUMMARY_LIMITS } from "../src/core/window";
import { rankBriefBlocks, selectRankedBriefBlocks } from "../src/core/rank";
import { compileBrief } from "../src/core/brief";
import type { NormalizedBlock } from "../src/types";
import { normalize } from "../src/core/normalize";
import { assistantText, assistantWithToolCall, userMsg } from "./fixtures";
/** compile at a ~128K window's section limits unless a test sets its own. */
const compile = (input: Omit<CompileInput, "limits"> & { limits?: CompileInput["limits"] }) => compileAt({ limits: DEFAULT_SUMMARY_LIMITS, ...input });

const briefPart = (summary: string): string => summary.split("\n\n---\n\n")[1] ?? "";

/** A block's score ranked on its own: no recency or neighbour bonus to tell two blocks apart. */
const scoreOf = (block: NormalizedBlock): number => rankBriefBlocks([block])[0].score;
const call = (name: string, args: Record<string, unknown>): NormalizedBlock => ({ kind: "tool_call", name, args });
const userRan = (command: string, exitCode = 0): NormalizedBlock => ({ kind: "bash", command, exitCode });

describe("brief ranking", () => {
  it("scores an edit and a test run above a read and another command", () => {
    const edit = scoreOf(call("Edit", { file_path: "src/auth.ts" }));
    const test = scoreOf(call("bash", { command: "bun test tests/auth.test.ts" }));
    for (const plain of [call("Read", { file_path: "src/auth.ts" }), call("bash", { command: "du -sh dist" })]) {
      expect(edit).toBeGreaterThan(scoreOf(plain));
      expect(test).toBeGreaterThan(scoreOf(plain));
    }
  });

  it("penalizes scaffolding-only bash so it ranks below substantive commands", () => {
    // The same preamble in front of real work is no penalty.
    expect(scoreOf(userRan("set -euo pipefail\nmake dist"))).toBeGreaterThan(scoreOf(userRan("set -euo pipefail\ncd /tmp/proj\nls -la")));
  });

  it("does not penalize a real command hidden after a stray '<<' with no terminator", () => {
    // `<<NOTE` has no closing `NOTE` line, so it must not be treated as a
    // heredoc opener that swallows the git commit below into a skipped body.
    expect(scoreOf(userRan("echo \"see <<NOTE for details\"\ngit commit -m fix"))).toBe(scoreOf(userRan("echo \"see NOTE for details\"\ngit commit -m fix")));
  });

  it("does not penalize a scaffolding command that failed (nonzero exit is a real fact)", () => {
    expect(scoreOf(userRan("cd /tmp/missing", 1))).toBe(scoreOf(userRan("make dist", 1)));
  });

  it("ranks a failed call above the same call that passed", () => {
    const run = (isError: boolean) => normalize([
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "make dist" } }] },
      { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: isError ? "make: *** [dist] Error 1" : "built" }], isError },
    ] as any).find((b) => b.kind === "tool_call")!;
    expect(scoreOf(run(true))).toBeGreaterThan(scoreOf(run(false)));
  });

  it("selects ranked blocks chronologically after scoring", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { file_path: "noise-a.ts" } },
      { kind: "tool_call", name: "Read", args: { file_path: "noise-b.ts" } },
      { kind: "user", text: "Fix auth bug" },
      { kind: "assistant", text: "Root cause is stale token refresh." },
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" } },
      { kind: "tool_call", name: "bash", args: { command: "bun test tests/auth.test.ts" } },
    ];

    const selected = selectRankedBriefBlocks(blocks, { maxBlocks: 4, preserveRecentBlocks: 1 });

    expect(selected).toEqual([
      blocks[2],
      blocks[3],
      blocks[4],
      blocks[5],
    ]);
  });

  it("boosts non-trivial assistant turns that close a user segment", () => {
    // The same reply in the same place, followed by the next request or by more work.
    const scoreAt = (text: string, next: NormalizedBlock) =>
      rankBriefBlocks([{ kind: "user", text: "Fix auth bug" }, { kind: "assistant", text }, next])[1].score;
    const report = "Implemented the auth fix, verified the focused auth test, confirmed the changed file is limited to src/auth.ts, and no follow-up blockers remain for this task.";
    const nextRequest: NormalizedBlock = { kind: "user", text: "ok next" };
    const moreWork = call("Read", { file_path: "noise-a.ts" });
    expect(scoreAt(report, nextRequest)).toBeGreaterThan(scoreAt(report, moreWork));
    expect(scoreAt("Done.", nextRequest)).toBe(scoreAt("Done.", moreWork));
  });

  it("does not spend ranked selection budget on tool results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix auth bug" },
      { kind: "assistant", text: "Root cause is stale token refresh." },
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" } },
      { kind: "tool_result", name: "Edit", text: "large hidden tool output".repeat(200) },
      { kind: "tool_result", name: "bash", text: "more hidden output".repeat(200) },
    ];

    const selected = selectRankedBriefBlocks(blocks, { maxBlocks: 4, preserveRecentBlocks: 2 });

    expect(selected).toContain(blocks[0]);
    expect(selected).toContain(blocks[1]);
    expect(selected).toContain(blocks[2]);
    expect(selected).not.toContain(blocks[3]);
    expect(selected).not.toContain(blocks[4]);
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
    const selected = selectRankedBriefBlocks(blocks, { maxBlocks: 4, preserveRecentBlocks: 0 });
    const pollCount = selected.filter((block) =>
      block.kind === "tool_call"
        && /^bash$/i.test(block.name)
        && typeof block.args.command === "string"
        && /gh pr (?:view|checks) 123/.test(block.args.command),
    ).length;

    expect(pollCount).toBeLessThanOrEqual(1);
    expect(selected).toContain(blocks[4]);
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
    // maxBriefChars because preserve-recent was added unconditionally. They must
    // now be charged against the budget (iterating newest-first) and skipped once full.
    const blocks: NormalizedBlock[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "assistant" as const,
      text: `recent block ${i} ` + "x".repeat(1200),
    }));
    const maxBriefChars = 3000;

    const selected = selectRankedBriefBlocks(blocks, {
      maxBlocks: 80,
      preserveRecentBlocks: 8, // ask to preserve every block
      maxBriefChars,
    });
    const rendered = compileBrief(selected);

    // Budget is a true ceiling even though all candidates are "recent" blocks.
    expect(rendered.length).toBeLessThanOrEqual(maxBriefChars);
    // Newest block is always kept (recency preserved).
    expect(selected).toContain(blocks[7]);
    // ...but not everything fits, so oldest recent blocks are dropped.
    expect(selected).not.toContain(blocks[0]);
    expect(selected.length).toBeLessThan(blocks.length);
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
    expect(selectRankedBriefBlocks(mkBlocks(10), opts)).toHaveLength(10);

    // Mid transcript (100 blocks -> 6000, between floor and ceiling): exceeds the floor.
    const mid = compileBrief(selectRankedBriefBlocks(mkBlocks(100), opts));
    expect(mid.length).toBeGreaterThan(4400);
    expect(mid.length).toBeLessThanOrEqual(6000);

    // Huge transcript (400 blocks -> 24000, clamped): never exceeds the ceiling.
    const huge = compileBrief(selectRankedBriefBlocks(mkBlocks(400), opts));
    expect(huge.length).toBeLessThanOrEqual(8000);
    expect(huge.length).toBeGreaterThan(mid.length);
  });

  it("ignores the size-relative ceiling unless slope and floor are both set", () => {
    // Ceiling alone must not change behavior: falls back to the flat maxBriefChars.
    const blocks: NormalizedBlock[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "assistant" as const,
      text: `block ${i} ` + "x".repeat(300),
    }));
    const flat = compileBrief(selectRankedBriefBlocks(blocks, { maxBlocks: 500, preserveRecentBlocks: 0, maxBriefChars: 4400 }));
    const ceilOnly = compileBrief(
      selectRankedBriefBlocks(blocks, { maxBlocks: 500, preserveRecentBlocks: 0, maxBriefChars: 4400, maxBriefCharsCeiling: 8000 }),
    );
    expect(ceilOnly.length).toBe(flat.length);
    expect(flat.length).toBeLessThanOrEqual(4400);
  });
});
