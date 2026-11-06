// The Lisp core's learned limits and outcome texts (lisp/src/limits.lisp and
// outcome.lisp, ops limits and outcome) against model-limits.ts,
// window-limits.ts, stats.ts, compact-feedback.ts, details.ts and settings.ts:
// generated limits files learned into and read (malformed, arrays, odd entries),
// the window each model gets, the settle decision, outcome lines across
// toFixed's ties, what /omp-vcc says of each error, whose details a compaction
// carries, and the provider opt-out under Unicode case. Skips without SBCL.
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepHostPolicy, learnedHostPolicy, learnWindow, modelKey, windowOf } from "../src/core/model-limits";
import { formatCompactionStats } from "../src/compaction/stats";
import { reportCompactError } from "../src/commands/compact-feedback";
import { vccDetailsOf } from "../src/details";
import { handlesHostCompactions, DEFAULT_SETTINGS } from "../src/core/settings";
import { registerWindowTracking, createWindowState } from "../src/hooks/window-limits";
import { OMP_TRIGGER_RULE, PI_TRIGGER_RULE } from "../src/core/window";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), "omp-vcc-lisp-outcome-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const MODELS = [
  undefined, { provider: "openscale", id: "deepseek", contextWindow: 128_000 }, { provider: "openscale", id: "deepseek", contextWindow: 40_000 },
  { provider: "anthropic", id: "claude", contextWindow: 200_000 }, { provider: "anthropic", id: "claude" }, { provider: "", id: "x", contextWindow: 1000 },
  { provider: "lm", id: "local", contextWindow: 32_768.5 }, { provider: "lm", id: "local", contextWindow: -5 }, { id: "noprov", contextWindow: 8000 },
];
const FILES = [
  undefined, "", "not json", "[]", "[1,2]", "null", "\"str\"", "{}",
  JSON.stringify({ "openscale/deepseek": { contextWindow: 40_000, source: "overflow-error", at: "2026-01-01T00:00:00.000Z" } }),
  JSON.stringify({ "openscale/deepseek": { contextWindow: 40_000, hostPolicy: { reserveTokens: 4_000 } }, "anthropic/claude": 5 }),
  JSON.stringify({ "anthropic/claude": "ab", "lm/local": { contextWindow: "big" } }),
  JSON.stringify({ "lm/local": { contextWindow: 16_000, hostPolicy: { enabled: false } }, "openscale/deepseek": null }),
  JSON.stringify({ "anthropic/claude": { contextWindow: 100_000, hostPolicy: [1] }, "lm/local": { hostPolicy: "x" } }),
];
/** Learned windows with the host's policy recorded beside them: where a settled run may compact. */
const SETTLE_FILE = JSON.stringify({
  "openscale/deepseek": { contextWindow: 40_000, hostPolicy: { reserveTokens: 4_000 } },
  "anthropic/claude": { contextWindow: 100_000, hostPolicy: { thresholdPercent: 50 } },
  "lm/local": { contextWindow: 16_000, hostPolicy: { enabled: true } },
});
const POLICIES = [undefined, {}, { reserveTokens: 4_000 }, { reserveTokens: 16_384, enabled: true }, { enabled: false }, { thresholdPercent: 70 }];

/** One world's run of limit operations: what each returned, and the file after. */
const runLimits = (seed: number, useCore: string | undefined) => {
  const r = rng(seed * 6007);
  const d = join(dir, `l${seed}-${useCore ? "core" : "ts"}`);
  mkdirSync(d, { recursive: true });
  const file = pick(r, FILES);
  if (file !== undefined) writeFileSync(join(d, "omp-vcc-models.json"), file);
  const out: unknown[] = [];
  withCore(useCore, () => {
    for (let i = 0; i < 6; i++) {
      const model = pick(r, MODELS);
      const roll = r();
      if (roll < 0.35) out.push({ learn: learnWindow(d, model, pick(r, [30_000, 40_000, 0, -1, 50_000.5, 16_000]), new Date(Date.UTC(2026, 10, 6, 1, 2, 3, i))) });
      else if (roll < 0.6) { keepHostPolicy(d, model, pick(r, POLICIES)); out.push({ kept: true }); }
      else if (roll < 0.8) out.push({ policy: learnedHostPolicy(d, modelKey(model)) ?? null });
      else out.push({ window: windowOf(model, pick(r, ["omp", "pi"] as const), d) });
    }
  });
  const path = join(d, "omp-vcc-models.json");
  return { out, file: existsSync(path) ? readFileSync(path, "utf8") : null };
};

/** The settle handler's decision, through a fake host: whether it compacted, and what it told. */
const runSettle = async (seed: number, useCore: string | undefined) => {
  const r = rng(seed * 3301);
  const d = join(dir, `s${seed}-${useCore ? "core" : "ts"}`);
  mkdirSync(d, { recursive: true });
  const file = pick(r, [...FILES.slice(8), SETTLE_FILE, SETTLE_FILE, SETTLE_FILE]);
  writeFileSync(join(d, "omp-vcc-models.json"), file);
  const configPath = join(d, "omp-vcc-config.json");
  writeFileSync(configPath, JSON.stringify(pick(r, [{}, { overrideDefaultCompaction: false }, { skipForProviders: ["OpenScale"] }, { skipForProviders: ["lm"] }])));
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const pi: any = { on: (n: string, h: any) => handlers.set(n, h) };
  const told: string[] = [];
  let compacted = 0;
  const rule = pick(r, [OMP_TRIGGER_RULE, PI_TRIGGER_RULE]);
  const host: any = {
    name: rule.name, rule, settledEvent: "agent_end", displayName: rule.name === "pi" ? "Pi" : "omp", modelsFile: "models.yml",
    config: { dir: () => d, path: () => configPath, load: () => withCore(useCore, () => ({ ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(configPath, "utf8")) })) },
    window: (m: any) => withCore(useCore, () => windowOf(m, rule.name, d)),
  };
  const state = createWindowState();
  registerWindowTracking(pi, state, host);
  const model = pick(r, MODELS.slice(1));
  const used = pick(r, [1_000, 25_000, 36_000, 39_000, 50_000, 120_000, 120_000]);
  const ctx = { model, hasUI: true, ui: { notify: (m: string) => told.push(m) }, getContextUsage: () => ({ tokens: used }), isIdle: () => true, compact: () => { compacted++; } };
  withCore(useCore, () => handlers.get("agent_end")!({}, ctx));
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { told, compacted, selfTrigger: state.selfTrigger };
};

maybe("Lisp core limits and outcome", () => {
  it("learns, keeps and reads generated limits files as model-limits.ts does", () => {
    for (let seed = 1; seed <= 120; seed++) expect({ seed, ...runLimits(seed, core) }).toEqual({ seed, ...runLimits(seed, undefined) });
    // Every file read for every model: the window it gets and the policy kept for it.
    FILES.forEach((file, f) => {
      const d = join(dir, `every-${f}`);
      mkdirSync(d, { recursive: true });
      if (file !== undefined) writeFileSync(join(d, "omp-vcc-models.json"), file);
      for (const model of MODELS) {
        const read = (useCore: string | undefined) => withCore(useCore, () => ({ window: windowOf(model, "omp", d), policy: learnedHostPolicy(d, modelKey(model)) ?? null }));
        expect({ f, model, ...read(core) }).toEqual({ f, model, ...read(undefined) });
      }
    });
  }, 120_000);

  it("decides at a settled run as window-limits.ts does", async () => {
    let compacted = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const ts = await runSettle(seed, undefined);
      const lisp = await runSettle(seed, core);
      expect({ seed, ...lisp }).toEqual({ seed, ...ts });
      compacted += ts.compacted;
    }
    expect(compacted).toBeGreaterThan(5);
  }, 120_000);

  it("writes outcome lines, error feedback, details and the provider opt-out as the TypeScript does", () => {
    const r = rng(99);
    for (let i = 0; i < 300; i++) {
      const stats = {
        summarized: Math.floor(r() * 400), keptUserTurns: Math.floor(r() * 5), totalUserTurns: Math.floor(r() * 9),
        keptTokensEst: pick(r, [0, 999, 1000, 1049, 1050, 1150, 1250, 1950, 9950, 99_950, 12_345, Math.floor(r() * 50_000)]),
        ...(r() < 0.4 ? { budgetCut: pick(r, ["final_reply", "running_turn", "no_anchor", "oversized_tail"]) } : {}),
        ...(r() < 0.5 ? { smartKeepAdjusted: r() < 0.5 } : {}),
      } as any;
      expect({ stats, line: withCore(core, () => formatCompactionStats(stats)) }).toEqual({ stats, line: withCore(undefined, () => formatCompactionStats(stats)) });
    }
    const MESSAGES = ["Compaction cancelled", "Already compacted", "Nothing to compact", "Nothing to compact (session too small)", "boom", "", "Nothing to compactx"];
    for (let i = 0; i < 200; i++) {
      const err = new Error(pick(r, MESSAGES));
      const mode = pick(r, [undefined, "tui", "rpc", "print"]);
      const notice = pick(r, [null, undefined, "", "omp-vcc: Too few messages to compact"]);
      const host = pick(r, ["omp", "Pi"] as const);
      const branch = pick(r, [[], [{ type: "compaction" }], [{ type: "compaction" }, { type: "reset_boundary" }], [{ type: "message" }]]);
      const run = (useCore: string | undefined) => {
        const told: unknown[] = [];
        const ctx: any = { mode, hasUI: true, ui: { notify: (m: string, t: string) => told.push([m, t]) }, sessionManager: { getBranch: () => branch } };
        withCore(useCore, () => reportCompactError(ctx, err, notice, host));
        return told;
      };
      expect({ i, told: run(core) }).toEqual({ i, told: run(undefined) });
    }
    const DETAILS = [undefined, null, 5, {}, { compactor: "omp-vcc", version: 2 }, { compactor: "pi-vcc", willRetry: true }, { compactor: "other" },
      { compactor: "other", hookDetails: { compactor: "omp-vcc", reason: "idle" } }, { hookDetails: { compactor: "x" } }, { hookDetails: "omp-vcc" }];
    for (const d of DETAILS) expect({ d, own: withCore(core, () => vccDetailsOf(d)) }).toEqual({ d, own: withCore(undefined, () => vccDetailsOf(d)) });
    const PROVIDERS = [undefined, null, 5, "anthropic", "Anthropic", "ANTHROPIC", "İstanbul", "istanbul", "i̇stanbul", "ΟΔΟΣ", "οδος", "οδοσ", "Straße", "STRASSE", "Ǆ", "ǆ"];
    for (const skip of [[], ["anthropic"], ["İSTANBUL"], ["οδος"], ["strasse", "ǅ"]]) {
      for (const override of [true, false]) {
        const settings = { ...DEFAULT_SETTINGS, overrideDefaultCompaction: override, skipForProviders: skip };
        for (const p of PROVIDERS) {
          expect({ skip, override, p, h: withCore(core, () => handlesHostCompactions(settings, p)) }).toEqual({ skip, override, p, h: withCore(undefined, () => handlesHostCompactions(settings, p)) });
        }
      }
    }
  }, 120_000);
});
