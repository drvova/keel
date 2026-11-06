// The Lisp core's window rules (lisp/src/window.lisp, op window) against
// src/core/window.ts: the limit overflow errors state, each host's trigger from
// the policy it hands the hook (as it came, malformed now and then, and as a
// recorded policy), whether it compacts on its own, and the budgets below the
// trigger, over generated windows, policies, context counts and overheads.
// Skips without SBCL.
import { describe, expect, it } from "bun:test";
import { compactionBudgets, limitFromOverflowError, OMP_TRIGGER_RULE, PI_TRIGGER_RULE, triggerFor } from "../src/core/window";
import { callCore } from "../src/core/lisp-core";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const inCore = (cases: object[]): any[] => withCore(core, () => callCore({ op: "window", cases }))?.results as any[];

// The phrasings each LIMIT_PATTERNS entry reads, and some it does not.
const ERRORS = [
  "This model's maximum context length is {n} tokens. However, you requested 140000 tokens",
  "context length of only {n} tokens",
  "prompt is too long: 210000 tokens > {n} maximum",
  "The maximum prompt length is {n} for this model",
  "The input token count exceeds the maximum number of tokens allowed ({n}).",
  "request exceeds the context window of {n}",
  "input exceeds the token limit of {n}", "Exceeds The Context Limit Of {n}",
  "the request exceeds the limit of {n} tokens",
  "prompt exceeds the context ({n})", "leaves no room in the context ({n})",
  "the request (140000 tokens) exceeds the available context size ({n} tokens)",
  "n_ctx: {n}", "n_ctx_slot = {n}", "n_ctx is far too small: {n}",
  "context window is {n}", "context size of {n}",
  "Trying to keep the first 9000 tokens when context the overflows. greater than the context length of {n}",
  "rate limit exceeded", "maximum context length is unknown", "",
];
const NUMBERS = ["131072", "128,000", "1,048,576", "512", "1023", "1024", "0", "9".repeat(400), "32768", "4,096,000", ",,1", "4".repeat(25), "1".repeat(309)];

const SETTINGS: unknown[] = [
  undefined, null, "settings", 7, [], {}, { enabled: false }, { enabled: true }, { strategy: "off" }, { strategy: "context-full" },
  { reserveTokens: 16_384 }, { reserveTokens: 0 }, { reserveTokens: -5 }, { reserveTokens: 4_000 }, { reserveTokens: 200_000 }, { reserveTokens: 1e9 },
  { reserveTokens: "8000" }, { thresholdPercent: 70 }, { thresholdPercent: 0.5 }, { thresholdPercent: 150 }, { thresholdPercent: 33.3 },
  { thresholdTokens: 30_000 }, { thresholdTokens: 30_000.5 }, { thresholdTokens: 10_000_000 }, { thresholdTokens: 0 }, { thresholdTokens: -1 },
  { baseWindowTokens: 64_000, thresholdPercent: 85 }, { baseWindowTokens: 64_000 }, { baseWindowTokens: 2_000_000, reserveTokens: 1_000 },
  { thresholdTokens: 30_000, reserveTokens: 8_000 }, { enabled: "no", thresholdPercent: "70" },
];
const WINDOWS = [undefined, 0, 1, 2, 1000, 8_192, 16_000, 19_000, 32_768, 40_000, 100_000, 128_000, 200_000, 400_000, 1_000_000, 2_000_000];

maybe("Lisp core window rules", () => {
  it("reads the limit of overflow errors as limitFromOverflowError does", () => {
    const texts: unknown[] = [undefined, null, 42, { message: "maximum context length is 131072 tokens" }];
    for (const e of ERRORS) for (const n of NUMBERS) texts.push(e.replaceAll("{n}", n));
    const r = rng(7);
    for (let i = 0; i < 200; i++) texts.push(`${pick(r, ["Error: ", "400 ", ""])}${pick(r, ERRORS).replaceAll("{n}", pick(r, NUMBERS))}${pick(r, ["", " (request id x)", "; maximum context length is 2048 tokens"])}`);
    const lisp = inCore(texts.map((error) => ({ error: error ?? null })));
    expect(lisp.length).toBe(texts.length);
    const found = texts.map((t, i) => ({ t, limit: lisp[i].limit }));
    expect(found).toEqual(texts.map((t) => ({ t, limit: limitFromOverflowError(t) })));
    expect(found.filter((f) => f.limit !== undefined).length).toBeGreaterThan(100);
  });

  it("works out each host's trigger and budgets as window.ts does", () => {
    const r = rng(11);
    const cases: any[] = [];
    for (const rule of [OMP_TRIGGER_RULE, PI_TRIGGER_RULE]) {
      for (const window of WINDOWS) for (const hostSettings of SETTINGS) cases.push({ rule, window, hostSettings, recovering: false, overheadTokens: 0, workingSet: true });
      for (let i = 0; i < 600; i++) {
        cases.push({
          rule, window: pick(r, WINDOWS), hostSettings: pick(r, SETTINGS), recovering: r() < 0.3,
          tokensBefore: pick(r, [undefined, 0, -3, 900, 30_000.7, 150_000, 3_000_000]),
          overheadTokens: pick(r, [0, -10, 1_500, 9_000.25, 40_000, 400_000]), workingSet: r() < 0.7,
        });
      }
    }
    // A recorded policy, as window-limits.ts hands it.
    for (const rule of [OMP_TRIGGER_RULE, PI_TRIGGER_RULE]) for (const s of SETTINGS) {
      const policy = rule.policyOf(s);
      if (policy) cases.push({ rule, window: pick(r, WINDOWS), policy, recovering: false, overheadTokens: 0, workingSet: true });
    }
    const lisp = inCore(cases.map(({ rule, ...c }) => ({ ...c, ruleName: rule.name, ...("hostSettings" in c ? { hostSettings: c.hostSettings ?? null } : {}) })));
    expect(lisp.length).toBe(cases.length);
    cases.forEach((c, i) => {
      // undefined settings reach the core as null: both are no policy.
      const policy = "policy" in c ? c.policy : c.rule.policyOf(c.hostSettings);
      const trigger = triggerFor(c.window, c.recovering, c.tokensBefore, policy, c.rule);
      const ts = { policy, trigger, autoCompacts: c.rule.autoCompacts(policy), budgets: compactionBudgets(trigger, c.overheadTokens, c.workingSet) };
      expect({ i, c: { ...c, rule: c.rule.name }, ...lisp[i] }).toEqual({ i, c: { ...c, rule: c.rule.name }, ...ts });
    });
  });

  it("sizes every trigger as compactionBudgets does", () => {
    // Across the edges: the reference trigger, the brief's ceiling, the working set's floor, the tail's clamps.
    const triggers = [undefined, 0, 0.5, 1, 7, 999, 1_000, 2_500, 5_000, 8_000, 12_345, 20_000, 31_999, 50_000, 72_000, 100_000, 108_799, 108_800, 108_801,
      150_000, 333_333, 499_999, 500_000, 500_001, 750_000, 1_000_000, 1_499_999, 1_500_001, 4_000_000];
    for (let t = 1_000; t < 2_000_000; t = Math.ceil(t * 1.07)) triggers.push(t);
    // Every trigger where the working set first fits its floor.
    for (let t = 2_000; t < 12_000; t++) triggers.push(t);
    const cases: Array<[number | undefined, number, boolean]> = [];
    for (const t of triggers) for (const o of [0, 700, 5_000, 30_000]) for (const ws of [true, false]) cases.push([t, o, ws]);
    // A fixed omp threshold under a window past it is that trigger exactly.
    const lisp = inCore(cases.map(([t, o, ws]) => ({ ruleName: "omp", window: t === undefined ? null : 10_000_000, policy: t === undefined ? null : { thresholdTokens: t }, overheadTokens: o, workingSet: ws })));
    cases.forEach(([t, o, ws], i) => {
      const trigger = t === undefined ? undefined : triggerFor(10_000_000, false, undefined, { thresholdTokens: t }, OMP_TRIGGER_RULE);
      expect({ t, o, ws, budgets: lisp[i].budgets }).toEqual({ t, o, ws, budgets: compactionBudgets(trigger, o, ws) });
    });
  });
});
