// The Lisp core's compaction plan against plan.ts planCompaction, on omp's own
// convertToLlm: generated branches (earlier compactions, /clear, custom
// messages, branch summaries, pins, kept originals of what omp rewrote, Pi's context edits, every
// message shape) under every keep, reason and budget, the whole plan compared:
// the cut, the summary, the stored state, the history index, the working set,
// the stats, a cancel's notice. Skips without SBCL.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCompaction, planInCore, type PlanInput } from "../src/compaction/plan";
import { OMP_TRIGGER_RULE, PI_TRIGGER_RULE } from "../src/core/window";
import { ompConvertToLlm } from "./support/host";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), "omp-vcc-lisp-compaction-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const some = <T>(r: () => number, xs: readonly T[], p = 0.3): T[] => xs.filter(() => r() < p);

const WORDS = ["fix", "the", "rounding", "bug", "in", "src/money.ts", "and", "run", "tests", "please", "café", "🎉", "deploy", "src/a.ts", "README.md", "never", "staging"];
const words = (r: () => number, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(pick(r, [" ", " ", "\n"]));
const FILES = ["src/money.ts", "src/a.ts", "src/b.ts", "README.md", "/repo/src/c.ts"];
const fileText = (r: () => number) =>
  Array.from({ length: 3 + Math.floor(r() * (r() < 0.2 ? 400 : 40)) }, (_, i) => `${i + 1}: ${r() < 0.05 ? "y".repeat(350) : words(r, 6)}`).join("\n");

/** A branch: its entries, the #N of each message, and the kept originals for some. */
const branch = (seed: number) => {
  const r = rng(seed);
  const entries: any[] = [];
  const store: string[] = [];
  const index = new Map<string, number>();
  let n = 0;
  let parent: string | null = null;
  const calls: string[] = [];
  const push = (e: any) => {
    const id = `e${seed}-${entries.length}`;
    entries.push({ id, parentId: parent, timestamp: "2026-11-06T10:00:00.000Z", ...e });
    parent = id;
    if (e.type === "message" && e.message) index.set(id, n++);
    return id;
  };
  const size = 6 + Math.floor(r() * 70);
  for (let i = 0; i < size; i++) {
    const roll = r();
    if (i === 0 && r() < 0.15) push({ type: "message", message: { role: "user", content: `a long paste ${"z ".repeat(30_000)}` } });
    else if (roll < 0.15) push({ type: "message", message: { role: "user", content: r() < 0.15
      ? [{ type: "text", text: words(r, 6) }, { type: "image", mimeType: "image/png", data: "AAAA" }]
      : pick(r, [words(r, 3 + Math.floor(r() * 20)), `look at ${pick(r, FILES)} and fix it`, "ok", `<system-reminder>x</system-reminder>`, `<system-reminder>x</system-reminder> then fix ${pick(r, FILES)}`]),
      ...(r() < 0.05 ? { attribution: "agent" } : {}) } });
    else if (roll < 0.45) {
      const parts: any[] = [];
      if (r() < 0.6) parts.push({ type: "text", text: words(r, 4 + Math.floor(r() * 40)) });
      for (let k = 0; k < (r() < 0.3 ? 0 : 1 + Math.floor(r() * 2)); k++) {
        const id = `t${seed}-${i}-${k}`;
        calls.push(id);
        const path = pick(r, FILES);
        parts.push({ type: "toolCall", id, ...pick(r, [
          { name: "read", arguments: { path: r() < 0.3 ? `${path}:10-30` : path } },
          { name: "write", arguments: { path, content: fileText(r) } },
          { name: "edit", arguments: { path, edits: [{ oldText: "a", newText: "b" }] } },
          { name: "bash", arguments: { command: pick(r, ["bun test", "git commit -m \"fix: x\"", "ls", `cat ${path}`]) } },
          { name: "grep", arguments: { pattern: "TODO", path: "src" } },
        ]) });
      }
      push({ type: "message", message: { role: "assistant", content: parts, usage: pick(r, [
        { input: 100 + i * 50, output: 10, cacheRead: 0, cacheWrite: 0 }, { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 },
        { input: 40 + i, output: 10, cacheRead: 2_000 + i * 70, cacheWrite: 300 }, { input: "120", cacheRead: null, cacheWrite: "x" }, undefined, 0,
      ]) } });
    } else if (roll < 0.7 && calls.length) {
      const id = push({ type: "message", message: { role: "toolResult", toolCallId: pick(r, calls), toolName: "bash", content: [{ type: "text", text: r() < 0.5 ? fileText(r) : words(r, 10) }], ...(r() < 0.2 ? { isError: true } : {}), ...(r() < 0.15 ? { prunedAt: 1 } : {}) } });
      if (r() < 0.5) store.push(JSON.stringify({ id, content: [{ type: "text", text: `original ${fileText(r)}` }] }));
    } else if (roll < 0.75) push({ type: "custom_message", customType: pick(r, ["notice", "omp-vcc-pin", "other"]), content: words(r, 5), display: true });
    else if (roll < 0.78) push({ type: "branch_summary", summary: words(r, 12), fromId: "x" });
    else if (roll < 0.82) push({ type: "custom", customType: "omp-vcc.pin", data: r() < 0.7 ? { v: 1, op: "add", id: 1 + Math.floor(r() * 3), text: words(r, 4), by: pick(r, ["user", "agent"]), at: n } : { v: 1, op: "remove", id: 1 } });
    else if (roll < 0.84) push({ type: "reset_boundary" });
    else if (roll < 0.9 && entries.length > 3) {
      const earlier = entries[Math.floor(r() * entries.length)];
      push({ type: "compaction", summary: words(r, 20), firstKeptEntryId: r() < 0.6 ? earlier.id : r() < 0.5 ? "" : "gone", tokensBefore: 1000,
        ...(r() < 0.3 ? { providerReplayThroughEntryId: earlier.id } : {}),
        details: r() < 0.7 ? { compactor: pick(r, ["omp-vcc", "pi-vcc"]), version: 2, sections: [], summaryState: r() < 0.8 ? {
          earlyRequests: ["first ask"], earlySlots: 2, files: { modified: ["src/a.ts"], created: [], read: ["src/money.ts"] },
          commits: [{ hash: "abc1234", message: "fix: earlier" }], tracked: [], userMessages: ["an earlier message"], brief: "[user]\nearlier",
        } : { files: "broken" }, historyIndex: r() < 0.7 ? [{ from: 0, to: 3, requests: 1, asks: ["first ask"], files: ["src/a.ts"], commits: [], commitCount: 0, failed: 0 }] : "broken" } : undefined });
    } else if (roll < 0.94 && entries.length > 2) {
      // Pi's context edits: an omission or a new content of an earlier entry.
      push({ type: "context_edit", targetId: entries[Math.floor(r() * entries.length)].id,
        replacement: pick(r, [null, { content: "[redacted]" }, { content: [{ type: "text", text: words(r, 8) }] }, { content: fileText(r) }]) });
    } else push({ type: "model_change", model: "x" });
  }
  const file = join(dir, `s${seed}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (store.length) writeFileSync(`${file}.vcc-raw`, store.join("\n") + "\n");
  return { entries, index, file };
};

/** Sized for a trigger of exactly `trigger` tokens (omp's fixed threshold on a 1M window), or none when undefined. */
const sizedFor = (trigger: number | undefined, workingSet: boolean) => ({
  rule: OMP_TRIGGER_RULE, window: trigger ? 1_000_000 : undefined, hostSettings: trigger ? { thresholdTokens: trigger } : undefined, tokensBefore: 0,
  settings: { skipCustomTypes: [], trackCommands: [], smartKeepTail: true, workingSet },
});

const inputOf = (seed: number, r: () => number): PlanInput => {
  const { entries, index, file } = branch(seed);
  const lastCompaction = [...entries].reverse().find((e) => e.type === "compaction");
  const reason = pick(r, ["manual", "threshold", "idle", "overflow", "incomplete"] as const);
  return {
    branchEntries: entries,
    convert: ompConvertToLlm,
    keepUserTurns: r() < 0.7 ? null : pick(r, [0, 1, 2, 5]),
    fromCommand: r() < 0.2,
    reason,
    recovering: reason === "overflow" || reason === "incomplete",
    settings: { skipCustomTypes: some(r, ["notice", "other"]), trackCommands: some(r, ["git", "bun"]), smartKeepTail: r() < 0.6, workingSet: r() < 0.8 },
    rule: r() < 0.6 ? OMP_TRIGGER_RULE : PI_TRIGGER_RULE,
    window: pick(r, [undefined, 16_000, 40_000, 128_000, 200_000, 1_000_000]),
    windowSource: pick(r, ["omp", "pi", "overflow-error", "unknown"]),
    ...(r() < 0.8 ? { willRetry: r() < 0.3 } : {}),
    // The host's policy as it came, malformed now and then.
    hostSettings: pick(r, [undefined, {}, { enabled: true, reserveTokens: 16_384 }, { thresholdPercent: 70 }, { thresholdTokens: 30_000, reserveTokens: 8_000 },
      { baseWindowTokens: 64_000, thresholdPercent: 85 }, { reserveTokens: 4_000 }, { reserveTokens: "x", thresholdTokens: Number.NaN }, "settings"]),
    // The host's count of the context: none, under the messages, about them, well over them.
    tokensBefore: pick(r, [0, 500, 20_000, 90_000, 300_000]),
    ...(r() < 0.15 ? { selfStarted: r() < 0.3 ? {} : { usedTokens: pick(r, [1_000, 50_000, 500_000]) } } : {}),
    sessionFile: r() < 0.8 ? file : undefined,
    indexById: r() < 0.9 ? index : undefined,
    previousSummary: lastCompaction && r() < 0.8 ? lastCompaction.summary : undefined,
    fileOps: { read: some(r, FILES), changed: some(r, FILES) },
  };
};

maybe("Lisp core compaction plan", () => {
  it("plans generated compactions as planCompaction does", () => {
    const kinds: Record<string, number> = {};
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 104729);
      const input = inputOf(seed, r);
      const ts = withCore(undefined, () => planCompaction(input));
      const lisp = withCore(core, () => planInCore(input));
      expect(lisp).toBeDefined();
      expect({ seed, ...lisp }).toEqual({ seed, ...ts });
      const kind = ts.kind === "cancel" ? `cancel:${ts.why}` : ts.kind === "compact" ? `compact${ts.budgetCut ? `:${ts.budgetCut}` : ts.compactAll ? ":all" : ""}${ts.workingSet ? "+ws" : ""}${ts.sections.includes("Task State") ? "+task" : ""}` : ts.kind;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    // The generated branches reach every kind of plan.
    expect(Object.keys(kinds).filter((k) => k.endsWith("+task")).reduce((n, k) => n + kinds[k], 0)).toBeGreaterThan(15);
    for (const k of ["compact", "compact+ws", "cancel:no_cut", "cancel:policy", "step_aside"]) expect(Object.keys(kinds).some((x) => x.startsWith(k))).toBe(true);
    expect(Object.keys(kinds).length).toBeGreaterThan(6);
  }, 300_000);

  it("plans the growth guard and an oversized tail as planCompaction does", () => {
    const base = inputOf(7, rng(1));
    const msg = (id: string, message: unknown) => ({ type: "message", id, parentId: null, message });
    const cases: Array<[string, PlanInput, string]> = [];
    // A short prefix whose summary is bigger than what it replaces: the guard cancels a manual pass and says why.
    for (const [reason, recovering, keep] of [["manual", false, 1], ["threshold", false, 1], ["manual", false, 0], ["overflow", true, 0]] as const) {
      cases.push([`growth ${reason} keep:${keep}`, {
        ...base, reason, recovering, keepUserTurns: keep, previousSummary: undefined, sessionFile: undefined, fromCommand: false,
        branchEntries: [
          // Pins put a long [Pinned Notes] in any summary of it.
          ...Array.from({ length: 23 }, (_, i) => ({ type: "custom", id: `p${i}`, parentId: null, customType: "omp-vcc.pin", data: { v: 1, op: "add", id: i + 1, text: `a pinned note about the deploy, number ${i}`, by: "user" } })),
          msg("a", { role: "user", content: "hi there" }), msg("b", { role: "assistant", content: [{ type: "text", text: "ok" }] }),
          msg("c", { role: "user", content: "next" }), msg("d", { role: "assistant", content: [{ type: "text", text: "done" }] })],
      }, "cancel"]);
    }
    // One user turn whose tool output is far past the tail budget: cut inside it.
    const big = "x ".repeat(40_000);
    cases.push(["oversized tail", {
      ...base, reason: "threshold", recovering: false, keepUserTurns: null, fromCommand: false, ...sizedFor(8_000, false),
      branchEntries: [
        msg("u1", { role: "user", content: "first request about src/a.ts" }), msg("a1", { role: "assistant", content: [{ type: "text", text: "on it" }] }),
        msg("u2", { role: "user", content: "second request" }),
        ...Array.from({ length: 6 }, (_, i) => [
          msg(`c${i}`, { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `step ${i}` } }] }),
          msg(`r${i}`, { role: "toolResult", toolCallId: `t${i}`, toolName: "bash", content: [{ type: "text", text: big }] }),
        ]).flat(),
        msg("end", { role: "assistant", content: [{ type: "text", text: "finished" }] }),
      ],
    }, "compact"]);
    for (const [name, input, kind] of cases) {
      const ts = withCore(undefined, () => planCompaction(input));
      const lisp = withCore(core, () => planInCore(input));
      expect({ name, kind: ts.kind }).toEqual({ name, kind });
      expect({ name, ...lisp }).toEqual({ name, ...ts });
    }
    // The oversized-tail rule's 2.5 factor, and the growth guard's 25% share, each swept across its edge.
    const tailInput = cases[4][1];
    for (const max of [9_000, 10_000, 11_000, 12_000, 13_000, 14_000, 15_000, 16_000, 18_000]) {
      const input = { ...tailInput, ...sizedFor(max * 4, false) };
      expect({ max, ...withCore(core, () => planInCore(input)) }).toEqual({ max, ...withCore(undefined, () => planCompaction(input)) });
    }
    for (let k = 1; k <= 30; k++) {
      const input = { ...cases[0][1], branchEntries: [...cases[0][1].branchEntries.slice(0, 23),
        msg("a", { role: "user", content: `request ${"word ".repeat(k * 40)}` }), msg("b", { role: "assistant", content: [{ type: "text", text: "ok ".repeat(k * 30) }] }),
        msg("c", { role: "user", content: "next" }), msg("d", { role: "assistant", content: [{ type: "text", text: "done" }] })] };
      expect({ k, ...withCore(core, () => planInCore(input)) }).toEqual({ k, ...withCore(undefined, () => planCompaction(input)) });
    }
    // A first request over the tail budget on its own: the cut snaps past it, never to before it.
    const paste = { ...tailInput, reason: "manual" as const, ...sizedFor(100_000, false), branchEntries: [
      msg("p0", { role: "user", content: `paste ${"z ".repeat(60_000)}` }),
      msg("p1", { role: "assistant", content: [{ type: "toolCall", id: "q1", name: "bash", arguments: { command: "ls" } }] }),
      msg("p2", { role: "toolResult", toolCallId: "q1", toolName: "bash", content: [{ type: "text", text: "a b" }] }),
      msg("p3", { role: "assistant", content: [{ type: "toolCall", id: "q2", name: "bash", arguments: { command: "pwd" } }] }),
      msg("p4", { role: "toolResult", toolCallId: "q2", toolName: "bash", content: [{ type: "text", text: "/w" }] }),
    ] };
    expect(withCore(core, () => planInCore(paste))).toEqual(withCore(undefined, () => planCompaction(paste)));
    // Several files the work is on, competing for [Working Set]'s room: one that does not fit whole is left out.
    for (const lines of [20, 40, 60, 80, 120, 160]) {
      const file = (k: number) => Array.from({ length: lines }, (_, i) => `${k}.${i}: ${"content ".repeat(6)}`).join("\n");
      const reads = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].flatMap((path, k) => [
        msg(`w${k}`, { role: "assistant", content: [{ type: "toolCall", id: `wr${k}`, name: "read", arguments: { path } }] }),
        msg(`wr${k}-r`, { role: "toolResult", toolCallId: `wr${k}`, toolName: "read", content: [{ type: "text", text: file(k) }] }),
      ]);
      const input = { ...tailInput, reason: "manual" as const, keepUserTurns: 1, sessionFile: undefined, indexById: new Map(Array.from({ length: 20 }, (_, i) => [`x${i}`, i])),
        ...sizedFor(100_000, true), branchEntries: [
          msg("x0", { role: "user", content: "work on src/a.ts src/b.ts src/c.ts src/d.ts" }), ...reads,
          msg("x9", { role: "user", content: "now change src/a.ts src/b.ts src/c.ts and src/d.ts" }),
          msg("x10", { role: "assistant", content: [{ type: "text", text: "changing them" }] }),
        ] };
      input.indexById = new Map(input.branchEntries.map((e: any, i: number) => [e.id, i]));
      expect({ lines, ...withCore(core, () => planInCore(input)) }).toEqual({ lines, ...withCore(undefined, () => planCompaction(input)) });
    }
    // A pass omp-vcc started itself, at its trigger, a token under it and past it; and settings without the workingSet flag.
    for (const usedTokens of [29_999, 30_000, 30_001]) {
      const input = { ...tailInput, ...sizedFor(30_000, true), selfStarted: { usedTokens } };
      expect({ usedTokens, ...withCore(core, () => planInCore(input)) }).toEqual({ usedTokens, ...withCore(undefined, () => planCompaction(input)) });
    }
    const unset = { ...tailInput, ...sizedFor(100_000, true) };
    delete (unset.settings as { workingSet?: boolean }).workingSet;
    expect(withCore(core, () => planInCore(unset))).toEqual(withCore(undefined, () => planCompaction(unset)));
    // A request summarized away with more files changed since than the section names.
    const many = { ...tailInput, ...sizedFor(100_000, false), reason: "manual" as const, keepUserTurns: 0, fromCommand: true, branchEntries: [
      msg("t0", { role: "user", content: "rename the helper in every module" }),
      ...Array.from({ length: 11 }, (_, i) => [
        msg(`t${i}c`, { role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: "edit", arguments: { path: `src/m${i}.ts`, edits: [{ oldText: "a", newText: "b" }] } }] }),
        msg(`t${i}r`, { role: "toolResult", toolCallId: `tc${i}`, toolName: "edit", content: [{ type: "text", text: `${"changed line\n".repeat(30)}` }] }),
      ]).flat(),
    ] };
    const manyPlan = withCore(undefined, () => planCompaction(many));
    expect(manyPlan.kind === "compact" && manyPlan.summary).toContain("(+3 more)");
    expect(withCore(core, () => planInCore(many))).toEqual(manyPlan);
    const tail = withCore(undefined, () => planCompaction(cases[4][1]));
    expect(tail.kind === "compact" && tail.budgetCut).toBe("oversized_tail");
  }, 120_000);
});
