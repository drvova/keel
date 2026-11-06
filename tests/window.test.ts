// Limits that follow the model's context window (src/core/window.ts, model-limits.ts, hooks/window-limits.ts).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { assertRealPi, piInstalled } from "./support/pi";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  compactionBudgets,
  DEFAULT_BUDGETS,
  DEFAULT_SUMMARY_LIMITS,
  effectiveWindow,
  limitFromOverflowError,
  ompDefaultTrigger,
  ompPolicyOf,
  ompTrigger,
  RECOVERY_BAND,
  piPolicyOf,
  piTrigger,
  OMP_TRIGGER_RULE,
  PI_TRIGGER_RULE,
  triggerFor as triggerForRule,
  type TriggerRule,
} from "../src/core/window";
// omp's own function, which omp-vcc ports since omp does not export it to extensions.
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { learnedWindow, recordLearnedWindow } from "../src/core/model-limits";
import type { CompactionReason } from "../src/types";
import { windowOf as windowOfHost } from "../src/core/model-limits";
import { isRecovery, type HostName } from "../src/host";

/** The learned limits sit next to the test's config. */
const configDir = () => dirname(process.env.OMP_VCC_CONFIG_PATH!);
/** omp's unless a test names Pi's. */
const windowOf = (model: Parameters<typeof windowOfHost>[0], host: HostName = "omp") => windowOfHost(model, host, configDir());
/** As the hook calls it, for a pass the host does not retry: omp's rule unless a test names another. */
const triggerFor = (w: ReturnType<typeof windowOfHost>, reason: CompactionReason, before: number, policy?: object, rule: TriggerRule = OMP_TRIGGER_RULE) =>
  triggerForRule(w.effective, isRecovery({ reason, willRetry: false }), before, policy, rule);

let dir: string;
const prev = process.env.OMP_VCC_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-window-"));
  process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
});
afterAll(() => {
  if (prev === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(join(dir, "omp-vcc-models.json"), { force: true });
});

describe("limitFromOverflowError", () => {
  it("reads the limit, not the request size, from the errors providers send", () => {
    expect(limitFromOverflowError("This model's maximum context length is 32768 tokens. However, you requested 40112 tokens.")).toBe(32768);
    expect(limitFromOverflowError("prompt is too long: 210534 tokens > 200000 maximum")).toBe(200000);
    expect(limitFromOverflowError("The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).")).toBe(1048576);
    expect(limitFromOverflowError("request (40960 tokens) exceeds the available context size (32768 tokens)")).toBe(32768);
    expect(limitFromOverflowError("prompt (9000 tokens) + max tokens (4096) exceeds the context (12288)")).toBe(12288);
    expect(limitFromOverflowError("Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of only 8192 tokens")).toBe(8192);
  });

  it("names nothing for an overflow without a number, or a non-context cap", () => {
    expect(limitFromOverflowError("context_length_exceeded")).toBeUndefined();
    expect(limitFromOverflowError("chat history exceeds the 100-message limit")).toBeUndefined();
    expect(limitFromOverflowError("image exceeds the limit of 20 tokens")).toBeUndefined();
    expect(limitFromOverflowError(undefined)).toBeUndefined();
  });
});

describe("ompDefaultTrigger", () => {
  it("is the window less omp's reserve: 15% or 16,384, whichever is larger, 15% alone when that does not fit", () => {
    expect(ompDefaultTrigger(128_000)).toBe(108_800);
    expect(ompDefaultTrigger(1_000_000)).toBe(850_000);
    expect(ompDefaultTrigger(32_768)).toBe(16_384);
    expect(ompDefaultTrigger(16_384)).toBe(13_927);
  });
});

describe("ompTrigger", () => {
  it("is where omp compacts: the same as omp's resolveThresholdTokens for every policy and window", () => {
    const policies: Record<string, unknown>[] = [
      {},
      { thresholdPercent: 70 },
      { thresholdPercent: 0.5 },
      { thresholdPercent: 120 },
      { thresholdTokens: 90_000 },
      { thresholdTokens: 2_000_000 },
      { reserveTokens: 30_000 },
      { reserveTokens: 16_384 },
      { reserveTokens: 500_000 },
      { baseWindowTokens: 64_000 },
      { baseWindowTokens: 64_000, thresholdPercent: 50 },
      { baseWindowTokens: 64_000, thresholdTokens: 90_000 },
      { thresholdPercent: -1, thresholdTokens: -1 },
    ];
    for (const window of [4_096, 16_384, 32_768, 65_536, 128_000, 200_000, 1_000_000]) {
      for (const p of policies) {
        const settings = { enabled: true, keepRecentTokens: 20_000, ...p } as any;
        expect({ window, p, trigger: ompTrigger(window, ompPolicyOf(settings)) }).toEqual({ window, p, trigger: resolveThresholdTokens(window, settings) });
      }
    }
  });

  it("reads only the policy fields from omp's settings", () => {
    expect(ompPolicyOf({ enabled: false, strategy: "off", thresholdPercent: 80, reserveTokens: 20_000, keepRecentTokens: 9, remoteEndpoint: "x" }))
      .toEqual({ enabled: false, strategy: "off", thresholdPercent: 80, reserveTokens: 20_000 });
    expect(ompPolicyOf(undefined)).toBeUndefined();
    expect(ompPolicyOf({ thresholdTokens: Number.NaN })).toEqual({});
  });
});

describe("compactionBudgets", () => {
  it("keeps the old fixed numbers on a typical window and when nothing is known", () => {
    expect(compactionBudgets(undefined)).toEqual(DEFAULT_BUDGETS);
    expect(compactionBudgets(ompDefaultTrigger(128_000), 8_000)).toEqual(DEFAULT_BUDGETS);
    expect(compactionBudgets(ompDefaultTrigger(200_000), 8_000)).toEqual(DEFAULT_BUDGETS);
  });

  it("lands what is kept inside omp's recovery band on a small trigger", () => {
    // Seen live: a 9k-token trigger over an ~8k-token system prompt; and a 32K model.
    for (const [trigger, overhead] of [[30_000, 8_000], [16_384, 6_000], [ompDefaultTrigger(65_536), 8_000]]) {
      const b = compactionBudgets(trigger, overhead);
      expect(b.maxTailTokens).toBeLessThan(DEFAULT_BUDGETS.maxTailTokens);
      expect(overhead + b.maxTailTokens + b.briefCeilingTokens + 600).toBeLessThanOrEqual(RECOVERY_BAND * trigger);
      expect(b.minTailTokens).toBe(Math.round(b.maxTailTokens / 5));
    }
    // Overhead alone past the band: the floor, and nothing better exists.
    expect(compactionBudgets(9_000, 8_000).maxTailTokens).toBe(1_000);
  });

  it("raises the summary's ceiling and its sections, not the tail, on a very large window", () => {
    const b = compactionBudgets(ompDefaultTrigger(1_000_000), 10_000);
    expect(b.maxTailTokens).toBe(DEFAULT_BUDGETS.maxTailTokens);
    expect(b.briefTokens).toBe(DEFAULT_BUDGETS.briefTokens);
    expect(b.briefCeilingTokens).toBe(3_400);
    // The sections grow with the brief's ceiling, and so does the framing a summary may add.
    expect(b.summaryScale).toBe(1.7);
    expect(b.summary).toEqual({ userMessages: 26, filesPerCategory: 17, commits: 14, historyRanges: 14, briefLines: 204, commandsPerName: 17 });
    expect(b.growthMarginChars).toBe(850);
    // The ranked brief may cover more blocks too: 80 capped it on any window.
    expect(b.briefMaxBlocks).toBe(136);
    expect(compactionBudgets(ompDefaultTrigger(128_000)).briefMaxBlocks).toBe(DEFAULT_BUDGETS.briefMaxBlocks);
  });

  it("shrinks each summary section on a small window, never under its floor", () => {
    expect(compactionBudgets(ompDefaultTrigger(200_000), 8_000).summary).toEqual(DEFAULT_SUMMARY_LIMITS);
    const b = compactionBudgets(ompDefaultTrigger(32_768), 8_000);
    // The square root of the trigger's share of a ~128K window's.
    expect(b.summaryScale).toBe(0.39);
    expect(b.summary).toEqual({ userMessages: 6, filesPerCategory: 4, commits: 3, historyRanges: 3, briefLines: 47, commandsPerName: 4 });
    expect(b.growthMarginChars).toBe(DEFAULT_BUDGETS.growthMarginChars);
    expect(compactionBudgets(2_000).summary).toEqual({ userMessages: 4, filesPerCategory: 3, commits: 2, historyRanges: 3, briefLines: 30, commandsPerName: 3 });
  });
});

describe("effectiveWindow", () => {
  it("is the smallest known window", () => {
    expect(effectiveWindow(128_000, 1_000_000, undefined)).toBe(128_000);
    expect(effectiveWindow(128_000, undefined, 32_768)).toBe(32_768);
    expect(effectiveWindow(undefined, undefined)).toBeUndefined();
  });
});

describe("learned limits", () => {
  it("keeps the smallest limit an overflow stated, per model, across reads", () => {
    expect(recordLearnedWindow(configDir(), "eh/m", 65_536)).toBe(true);
    expect(recordLearnedWindow(configDir(), "eh/m", 131_072)).toBe(false);
    expect(recordLearnedWindow(configDir(), "eh/m", 32_768)).toBe(true);
    expect(learnedWindow(configDir(), "eh/m")).toBe(32_768);
    expect(learnedWindow(configDir(), "eh/other")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "omp-vcc-models.json"), "utf8"))["eh/m"]).toMatchObject({ contextWindow: 32_768, source: "overflow-error" });
  });
});

describe("triggerFor", () => {
  const model = { provider: "p", id: "m", contextWindow: 128_000 };

  it("an overflow pass is bounded by the context that overflowed", () => {
    expect(triggerFor(windowOf(model), "overflow", 30_000)).toBe(30_000);
  });

  it("omp's policy, as its compactions carry it, places the trigger; without one, omp's default for the window", () => {
    const w = windowOf(model);
    expect(triggerFor(w, "threshold", 70_000, { thresholdPercent: 50 })).toBe(64_000);
    expect(triggerFor(w, "manual", 40_000)).toBe(108_800);
    expect(triggerFor(w, "manual", 40_000, { thresholdTokens: 90_000 })).toBe(90_000);
    expect(triggerFor(w, "overflow", 30_000, { thresholdTokens: 90_000 })).toBe(30_000);
  });

  it("when a smaller real window is known, omp's trigger is above it and omp-vcc's own applies", () => {
    recordLearnedWindow(configDir(), "p/m", 32_768);
    const w = windowOf(model);
    expect(w).toMatchObject({ host: 128_000, learned: 32_768, effective: 32_768, source: "overflow-error" });
    expect(triggerFor(w, "threshold", 100_000)).toBe(16_384);
    // The user's own policy, on the real window: 80% of it, and a fixed 90K past it falls back as omp's does.
    expect(triggerFor(w, "threshold", 100_000, { thresholdPercent: 80 })).toBe(26_214);
    expect(triggerFor(w, "threshold", 100_000, { thresholdTokens: 90_000 })).toBe(16_384);
  });
});

describe("Pi's trigger rule", () => {
  it("is Pi's shouldCompact: the window less reserveTokens, 16,384 by default", () => {
    expect(piTrigger(200_000)).toBe(183_616);
    expect(piTrigger(128_000, { reserveTokens: 20_000 })).toBe(108_000);
    // A reserve at or past the window compacts every turn in Pi; the trigger floors at 1.
    expect(piTrigger(16_000, { reserveTokens: 16_384 })).toBe(1);
  });

  it("reads Pi's preparation.settings, and Pi's auto-compaction follows its enabled flag", () => {
    expect(piPolicyOf({ enabled: true, reserveTokens: 8_000, keepRecentTokens: 20_000 })).toEqual({ enabled: true, reserveTokens: 8_000 });
    expect(piPolicyOf(undefined)).toBeUndefined();
    expect(PI_TRIGGER_RULE.autoCompacts({ enabled: false })).toBe(false);
    expect(PI_TRIGGER_RULE.autoCompacts(undefined)).toBe(true);
  });

  it("sizes a compaction for Pi's trigger on the effective window, an overflow bounded by what overflowed", () => {
    const model = { provider: "p", id: "pi-m", contextWindow: 128_000 };
    const w = windowOf(model, "pi");
    expect(w).toMatchObject({ host: 128_000, effective: 128_000, source: "pi" });
    const policy = PI_TRIGGER_RULE.policyOf({ enabled: true, reserveTokens: 20_000, keepRecentTokens: 20_000 });
    expect(triggerFor(w, "threshold", 110_000, policy, PI_TRIGGER_RULE)).toBe(108_000);
    expect(triggerFor(w, "overflow", 90_000, policy, PI_TRIGGER_RULE)).toBe(90_000);
  });
});



describe.skipIf(!piInstalled())("piTrigger against Pi's own shouldCompact", () => {
  it("is the largest context Pi does not compact at", async () => {
    assertRealPi();
    const { shouldCompact }: any = await import("@earendil-works/pi-coding-agent");
    for (const window of [32_768, 128_000, 200_000, 1_000_000]) {
      for (const reserveTokens of [0, 8_000, 16_384, 50_000]) {
        if (reserveTokens >= window) continue;
        const settings = { enabled: true, reserveTokens, keepRecentTokens: 20_000 };
        const t = piTrigger(window, settings);
        expect(shouldCompact(t, window, settings)).toBe(false);
        expect(shouldCompact(t + 1, window, settings)).toBe(true);
      }
    }
  });
});
