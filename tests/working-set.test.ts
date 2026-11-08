// [Working Set]: what the next step needs, brought back at a compaction
// (lisp/src/working-set.lisp; op working-set runs it alone).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { core } from "../src/core";
import { compactionBudgets, ompDefaultTrigger } from "./support/window";
import { registerHook } from "./support/host";

let dir: string;
const prev = process.env.KEEL_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-working-set-"));
  process.env.KEEL_CONFIG_PATH = join(dir, "keel-config.json");
  writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
});
afterAll(() => {
  if (prev === undefined) delete process.env.KEEL_CONFIG_PATH;
  else process.env.KEEL_CONFIG_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

interface Item { index: number; title: string; note: string; text: string }
interface Pick { history: unknown[]; indices: number[]; kept: unknown[]; maxChars: number }
const run = (p: Pick) => core({ op: "working-set", ...p });
/** The items [Working Set] picks, best first. */
const selectWorkingSet = (p: Pick): Item[] => run(p).items;
/** The section's lines, of what it picks within MAXCHARS. */
const workingSetLines = (p: Pick): string[] => run(p).lines;

const text = (t: string) => [{ type: "text", text: t }];
const user = (t: string) => ({ role: "user", content: t });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, name: string, t: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, content: text(t), isError });
const say = (t: string) => ({ role: "assistant", content: text(t) });

const FILE = Array.from({ length: 60 }, (_, i) => (i === 41 ? "export const roundTotal = (x: number) => Math.floor(x * 100) / 100;" : `export const helper${i} = () => ${i};`)).join("\n");
const FAILURE = `${"bun test v1.4\n".repeat(30)}FAIL tests/billing.test.ts > rounds totals\nexpected 10.01, received 10.00`;

/** A task in progress: read the file, the test failed, the file was edited. */
const work = () => [
  user("Fix the rounding bug in src/billing/totals.ts; tests/billing.test.ts fails"),
  call("c1", "read", { path: "src/billing/totals.ts" }),
  result("c1", "read", FILE),
  call("c2", "bash", { command: "bun test tests/billing.test.ts" }),
  result("c2", "bash", FAILURE, true),
  call("c3", "edit", { path: "src/billing/totals.ts", oldText: "Math.floor", newText: "Math.round" }),
  result("c3", "edit", "ok"),
  say("I changed floor to round."),
];

describe("what it picks", () => {
  const indices = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("brings back the file the kept turn edits, by its latest version, and the failure nothing fixed", () => {
    const summarized = work();
    const kept = [user("still failing, keep going"), call("c4", "edit", { path: "src/billing/totals.ts", oldText: "a", newText: "b" })];
    const items = selectWorkingSet({ history: summarized, indices: indices(summarized.length), kept, maxChars: 20_000 });
    expect(items.map((i) => [i.index, i.title, i.note])).toEqual([
      [2, 'read "src/billing/totals.ts"', "the latest version, edited after at #5"],
      [4, 'bash "bun test tests/billing.test.ts" [failed]', "its end"],
    ]);
  });

  it("leaves out what the kept turn already holds and a failure a later run fixed", () => {
    const summarized = [...work(), call("c5", "bash", { command: "bun test tests/billing.test.ts" }), result("c5", "bash", "1 pass")];
    const kept = [user("now tidy it up"), call("c6", "read", { path: "src/billing/totals.ts" })];
    expect(selectWorkingSet({ history: summarized, indices: indices(summarized.length), kept, maxChars: 20_000 })).toEqual([]);
  });

  it("before the kept turn starts, goes on from the last summarized turn; with a tiny budget, nothing", () => {
    const summarized = work();
    const kept = [user("ok, continue")];
    const items = selectWorkingSet({ history: summarized, indices: indices(summarized.length), kept, maxChars: 20_000 });
    expect(items.map((i) => i.index)).toEqual([2, 4]);
    expect(selectWorkingSet({ history: summarized, indices: indices(summarized.length), kept, maxChars: 100 })).toEqual([]);
  });

  it("shows what omp's edit and a range read showed of the file first, newest first, then its last whole read", () => {
    const EDITED = "[src/billing/totals.ts]\n41:export const roundTotal = (x: number) => Math.round(x * 100) / 100;\n42:export const helper42 = () => 42;";
    const history = [
      user("Fix the rounding in src/billing/totals.ts"),
      call("r1", "read", { path: "src/billing/totals.ts" }), result("r1", "read", FILE),
      call("e1", "edit", { path: "src/billing/totals.ts", old_string: "Math.floor", new_string: "Math.round" }), result("e1", "edit", EDITED),
      call("r2", "read", { path: "src/billing/totals.ts:40-41" }), result("r2", "read", "export const helper40 = () => 40;\nexport const roundTotal = (x: number) => Math.round(x * 100) / 100;"),
      say("Done."),
    ];
    // The kept turn edits it again: omp's replace edit (old_string/new_string) is a change, not a read of it.
    const kept = [user("now round to cents"), call("e2", "edit", { path: "src/billing/totals.ts", old_string: "100", new_string: "1000" })];
    const [item, ...rest] = selectWorkingSet({ history, indices: indices(history.length), kept, maxChars: 20_000 });
    expect(rest).toEqual([]);
    expect([item.index, item.title, item.note]).toEqual([2, 'read "src/billing/totals.ts"', "the latest version, newest first, edited after in context"]);
    const lines = item.text.split("\n");
    expect(lines[0]).toBe('[#6 read "src/billing/totals.ts:40-41"]');
    expect(lines[3]).toBe('[#4 edit "src/billing/totals.ts"]');
    expect(lines[7]).toBe('[#2 read "src/billing/totals.ts"]');
    expect(lines[8]).toBe("export const helper0 = () => 0;");
    // Too big to come back whole: only the lines shown of it since.
    const [small] = selectWorkingSet({ history, indices: indices(history.length), kept, maxChars: 1_500 });
    expect([small.index, small.title, small.note]).toEqual([6, 'read "src/billing/totals.ts:40-41"', "its latest lines, newest first, edited after in context"]);
    expect(small.text.split("\n").filter((l) => l.startsWith("[#"))).toEqual(['[#6 read "src/billing/totals.ts:40-41"]', '[#4 edit "src/billing/totals.ts"]']);
  });

  it("ranks the rest by the latest request, a file's latest read only", () => {
    const summarized = [
      // An edit's result is the agent's own change, not something to look up.
      user("note the cluster down"),
      call("e1", "edit", { path: "notes.md", old_string: "a", new_string: "the pelican cluster region" }), result("e1", "edit", "[notes.md]\n1:the pelican cluster region\n2:moved"),
      user("look around"),
      call("r1", "read", { path: "docs/deploy.md" }), result("r1", "read", "old deploy notes: pelican staging cluster"),
      call("r2", "read", { path: "docs/deploy.md" }), result("r2", "read", "deploy notes: the pelican cluster moved to eu-west"),
      call("r3", "read", { path: "README.md" }), result("r3", "read", "a readme about something else entirely"),
      say("Read them."),
      // A finished request: its files are not the work in progress.
      user("thanks, that is all for now"), say("Done."),
    ];
    const kept = [user("which region is the pelican cluster in now?")];
    const items = selectWorkingSet({ history: summarized, indices: indices(summarized.length), kept, maxChars: 20_000 });
    expect(items.map((i) => [i.index, i.note])).toEqual([[7, "matches the latest request"]]);
  });

  it("brings back the files of the request in progress, most recent first", () => {
    const history = [
      user("tidy the billing module"),
      call("r1", "read", { path: "src/billing/totals.ts" }), result("r1", "read", "export const total = 1;\nexport const tax = 2;"),
      call("r2", "read", { path: "src/billing/format.ts" }), result("r2", "read", "export const fmt = (x: number) => `${x}`;\nexport const pad = 2;"),
      say("Both read."),
    ];
    const kept = [call("b1", "bash", { command: "bun test" })];
    const items = selectWorkingSet({ history, indices: indices(history.length), kept, maxChars: 20_000 });
    expect(items.map((i) => [i.title, i.note])).toEqual([['read "src/billing/format.ts"', "the latest version"], ['read "src/billing/totals.ts"', "the latest version"]]);
  });
});

describe("the section's lines", () => {
  const all = (n: number) => Array.from({ length: n }, (_, i) => i);
  const shape = (lines: string[], max: number) => {
    expect(lines.reduce((n, l) => n + l.length + 1, 0)).toBeLessThanOrEqual(max);
    expect(lines.some((l) => l.trim() === "")).toBe(false);
    expect(lines.filter((l) => !l.startsWith("    ")).every((l) => l.startsWith("- #"))).toBe(true);
  };

  it("fits the budget, has no blank line, and brings a file back whole or not at all", () => {
    const tight = workingSetLines({ history: work(), indices: all(8), kept: [user("go on")], maxChars: 2_000 });
    shape(tight, 2_000);
    // The 60-line file does not fit whole in 2,000 chars: the failure has the room.
    expect(tight.some((l) => l.startsWith("- #2 "))).toBe(false);
    expect(tight[0]).toBe('- #4 bash "bun test tests/billing.test.ts" [failed], its end:');
    expect(tight.at(-1)).toBe("    expected 10.01, received 10.00");
    const roomy = workingSetLines({ history: work(), indices: all(8), kept: [user("go on")], maxChars: 20_000 });
    shape(roomy, 20_000);
    expect(roomy).toContain("    export const roundTotal = (x: number) => Math.floor(x * 100) / 100;");
    expect(roomy.some((l) => l.includes("keel_recall expand:[2]"))).toBe(false);
  });

  it("quotes a long failure by its end, after where the earlier lines are", () => {
    const history = [user("run the tests"), call("t1", "bash", { command: "bun test" }), result("t1", "bash", `${"log line\n".repeat(300)}expected 1, received 2`, true)];
    const lines = workingSetLines({ history, indices: all(3), kept: [user("fix it")], maxChars: 2_000 });
    shape(lines, 2_000);
    expect(lines[0]).toBe('- #2 bash "bun test" [failed], its end:');
    expect(lines[1]).toMatch(/^    …\[\d+ earlier lines: keel_recall expand:\[2\]\]$/);
    expect(lines.at(-1)).toBe("    expected 1, received 2");
  });
});

describe("the budget follows the window", () => {
  it("3,800 tokens on a typical window and up to a 500K trigger, 14% of a smaller one within the landing room, none on a tiny one", () => {
    expect(compactionBudgets(undefined).workingSetTokens).toBe(3_800);
    expect(compactionBudgets(ompDefaultTrigger(128_000), 8_000).workingSetTokens).toBe(3_800);
    expect(compactionBudgets(ompDefaultTrigger(200_000), 8_000).workingSetTokens).toBe(3_800);
    expect(compactionBudgets(ompDefaultTrigger(1_000_000), 8_000).workingSetTokens).toBe(6_460);
    // 14% of a 40K window's trigger, when nothing else is known to take room.
    expect(compactionBudgets(ompDefaultTrigger(40_000)).workingSetTokens).toBe(3_306);
    // With omp's system prompt and tools measured: what the landing leaves above the tail's 1,000-token floor.
    const b40 = compactionBudgets(ompDefaultTrigger(40_000), 8_800);
    expect([b40.workingSetTokens, b40.maxTailTokens]).toEqual([2_090, 1_000]);
    // A 32K window's landing room is all the tail's floor: no working set.
    expect(compactionBudgets(ompDefaultTrigger(32_768), 8_000).workingSetTokens).toBe(0);
    // A small trigger with little else in context: 14% of it.
    expect(compactionBudgets(8_000, 1_000).workingSetTokens).toBe(1_120);
    expect(compactionBudgets(2_000).workingSetTokens).toBe(0);
  });

  it("with workingSet off, its room goes to the kept tail", () => {
    const on = compactionBudgets(ompDefaultTrigger(40_000), 8_800);
    const off = compactionBudgets(ompDefaultTrigger(40_000), 8_800, false);
    expect(off.workingSetTokens).toBe(0);
    expect(off.maxTailTokens).toBe(on.maxTailTokens + on.workingSetTokens);
    // On a typical window the tail is at its cap either way.
    expect(compactionBudgets(ompDefaultTrigger(128_000), 8_000, false).maxTailTokens).toBe(25_000);
    expect(compactionBudgets(undefined, 0, false).workingSetTokens).toBe(0);
  });
});

describe("in the compaction hook", () => {
  const entries = (messages: Record<string, unknown>[]) => messages.map((message, i) => ({ type: "message", id: `e${i}`, message }));
  const compact = (branch: any[], previousSummary?: string) => {
    let handler: any;
    registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    return handler({
      type: "session_before_compact", branchEntries: branch, customInstructions: "keep:1",
      preparation: { previousSummary, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 4_000 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} }, sessionManager: { getEntries: () => branch, getBranch: () => branch } }).compaction;
  };

  it("brings the file and the failure back, after [History Index], and replaces them at the next compaction", () => {
    // Earlier work in the same window, so the compaction removes enough for the set to fit in half of it.
    const earlier = [user("Set up the build"), call("c0", "bash", { command: "cat build.log" }), result("c0", "bash", "compiling module\n".repeat(600)), say("Built.")];
    const first = entries([...earlier, ...work(), user("still failing, keep going"), call("c4", "edit", { path: "src/billing/totals.ts", oldText: "a", newText: "b" }), result("c4", "edit", "ok")]);
    const one = compact(first);
    const summary = one.summary as string;
    expect(summary).toContain('[Working Set]\n- #6 read "src/billing/totals.ts", the latest version, edited after at #9:');
    expect(summary).toContain("    export const roundTotal = (x: number) => Math.floor(x * 100) / 100;");
    expect(summary).toContain('- #8 bash "bun test tests/billing.test.ts" [failed], its end:');
    expect(summary.indexOf("[Working Set]")).toBeGreaterThan(summary.indexOf("[History Index]"));
    expect(summary.indexOf("[Working Set]")).toBeLessThan(summary.indexOf("\n---\n"));
    expect(one.details.workingSet).toEqual([6, 8]);

    // The work goes on: a fresh read, the test passes, a new request.
    const second = entries([
      ...first.map((e) => e.message),
      call("c5", "read", { path: "src/billing/totals.ts" }), result("c5", "read", FILE.replace("Math.floor", "Math.round")),
      call("c6", "bash", { command: "bun test tests/billing.test.ts" }), result("c6", "bash", "1 pass"),
      say("Fixed: totals round now."),
      user("ok, continue"),
    ]);
    const two = compact(second, summary);
    expect(two.details.workingSet).toEqual([16]);
    expect(two.summary.match(/\[Working Set\]/g)).toHaveLength(1);
    expect(two.summary).toContain("    export const roundTotal = (x: number) => Math.round(x * 100) / 100;");
    expect(two.summary).not.toContain("[failed], its end:");
  });

  it("brings back a file read before an earlier compaction", () => {
    const earlier = [user("Set up the build"), call("c0", "bash", { command: "cat build.log" }), result("c0", "bash", "compiling module\n".repeat(600)), say("Built.")];
    const first = entries([...earlier, ...work(), user("still failing, keep going"), call("c4", "edit", { path: "src/billing/totals.ts", oldText: "a", newText: "b" }), result("c4", "edit", "ok")]);
    const summary = compact(first).summary as string;
    // Other work since, enough to compact again, then a request that names the file.
    const second = entries([
      ...first.map((e) => e.message),
      say("Now the deploy."), user("Check the deploy logs"),
      call("d1", "bash", { command: "cat deploy.log" }), result("d1", "bash", "deploying service\n".repeat(600)), say("Deployed."),
      user("back to src/billing/totals.ts: add a test for roundTotal"),
    ]);
    const two = compact(second, summary);
    expect(two.details.workingSet).toContain(6);
    expect(two.summary).toContain('- #6 read "src/billing/totals.ts", the latest version');
  });

  it("is left out with workingSet off", () => {
    writeFileSync(process.env.KEEL_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true, workingSet: false }));
    try {
      const branch = entries([user("Set up the build"), call("c0", "bash", { command: "cat build.log" }), result("c0", "bash", "compiling module\n".repeat(600)), say("Built."), ...work(), user("still failing"), call("c4", "edit", { path: "src/billing/totals.ts", oldText: "a", newText: "b" })]);
      const out = compact(branch);
      expect(out.summary).not.toContain("[Working Set]");
      expect(out.details.workingSet).toBeUndefined();
    } finally {
      writeFileSync(process.env.KEEL_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true }));
    }
  });
});
