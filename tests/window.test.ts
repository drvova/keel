// Limits that follow the model's context window (src/core/window.ts, model-limits.ts, hooks/window-limits.ts).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compactionBudgets,
  contextLengthOfModelEntry,
  DEFAULT_BUDGETS,
  DEFAULT_SUMMARY_LIMITS,
  effectiveWindow,
  limitFromOverflowError,
  ompDefaultTrigger,
  ompPolicyOf,
  ompTrigger,
  RECOVERY_BAND,
} from "../src/core/window";
// omp's own function, which omp-vcc ports since omp does not export it to extensions.
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { learnedWindow, probeProviderWindow, recordLearnedWindow, resetProviderProbes } from "../src/core/model-limits";
import { createCompactionState } from "../src/hooks/compaction";
import { triggerFor, windowOf } from "../src/hooks/window-limits";

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
  resetProviderProbes();
  rmSync(join(dir, "omp-vcc-models.json"), { force: true });
});

describe("contextLengthOfModelEntry", () => {
  it("reads the fields providers use, top-level or nested", () => {
    // Electron Hub (the real entry for glm-5.3-flash:dev, trimmed).
    expect(contextLengthOfModelEntry({ id: "glm-5.3-flash:dev", tokens: 1000000, context_length: 1000000, max_model_len: 1000000 })).toBe(1000000);
    expect(contextLengthOfModelEntry({ id: "m", max_model_len: 32768 })).toBe(32768); // vLLM
    expect(contextLengthOfModelEntry({ id: "m", context_window: 131072 })).toBe(131072); // Groq
    expect(contextLengthOfModelEntry({ id: "m", top_provider: { context_length: 200000 } })).toBe(200000);
    expect(contextLengthOfModelEntry({ id: "m", limits: { max_input_tokens: 400000 } })).toBe(400000);
    expect(contextLengthOfModelEntry({ id: "m", metadata: { context_window: "65536" } })).toBe(65536);
  });

  it("says nothing when the entry says nothing", () => {
    expect(contextLengthOfModelEntry({ id: "whisper-large-v3", object: "model" })).toBeUndefined();
    expect(contextLengthOfModelEntry({ id: "m", context_length: 0 })).toBeUndefined();
    expect(contextLengthOfModelEntry(null)).toBeUndefined();
  });
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
    expect(b.summary).toEqual({ userMessages: 26, filesPerCategory: 17, commits: 14, historyRanges: 14, briefLines: 204 });
    expect(b.growthMarginChars).toBe(850);
  });

  it("shrinks each summary section on a small window, never under its floor", () => {
    expect(compactionBudgets(ompDefaultTrigger(200_000), 8_000).summary).toEqual(DEFAULT_SUMMARY_LIMITS);
    const b = compactionBudgets(ompDefaultTrigger(32_768), 8_000);
    // The square root of the trigger's share of a ~128K window's.
    expect(b.summaryScale).toBe(0.39);
    expect(b.summary).toEqual({ userMessages: 6, filesPerCategory: 4, commits: 3, historyRanges: 3, briefLines: 47 });
    expect(b.growthMarginChars).toBe(DEFAULT_BUDGETS.growthMarginChars);
    expect(compactionBudgets(2_000).summary).toEqual({ userMessages: 4, filesPerCategory: 3, commits: 2, historyRanges: 3, briefLines: 30 });
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
    expect(recordLearnedWindow("eh/m", 65_536)).toBe(true);
    expect(recordLearnedWindow("eh/m", 131_072)).toBe(false);
    expect(recordLearnedWindow("eh/m", 32_768)).toBe(true);
    expect(learnedWindow("eh/m")).toBe(32_768);
    expect(learnedWindow("eh/other")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "omp-vcc-models.json"), "utf8"))["eh/m"]).toMatchObject({ contextWindow: 32_768, source: "overflow-error" });
  });
});

describe("probeProviderWindow", () => {
  const model = { provider: "electronhub", id: "glm-5.3-flash:dev", api: "openai-completions", baseUrl: "https://api.electronhub.ai/v1/", contextWindow: 128_000 };
  const registry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "X-Extra": "1" } }) };

  it("asks {baseUrl}/models once per base URL with omp's credentials", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers });
      return { ok: true, json: async () => ({ data: [{ id: "glm-5.3-flash:dev", context_length: 1_000_000 }, { id: "small", max_model_len: 32_768 }] }) };
    };
    expect(await probeProviderWindow(model, registry, fetchImpl)).toBe(1_000_000);
    expect(await probeProviderWindow({ ...model, id: "small" }, registry, fetchImpl)).toBe(32_768);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.electronhub.ai/v1/models");
    expect(calls[0].headers).toEqual({ "X-Extra": "1", Authorization: "Bearer test-key" });
  });

  it("asks nothing of a non-OpenAI API, and survives a failing or silent provider", async () => {
    let calls = 0;
    const failing = async () => { calls++; throw new Error("network down"); };
    expect(await probeProviderWindow({ ...model, api: "anthropic-messages" }, registry, failing)).toBeUndefined();
    expect(calls).toBe(0);
    expect(await probeProviderWindow(model, registry, failing)).toBeUndefined();
    resetProviderProbes();
    const silent = async () => ({ ok: true, json: async () => ({ data: [{ id: "glm-5.3-flash:dev" }] }) });
    expect(await probeProviderWindow(model, registry, silent)).toBeUndefined();
    resetProviderProbes();
    const noKey = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "N/A", headers: {} }) };
    let seen: Record<string, string> | undefined;
    await probeProviderWindow(model, noKey, async (_url, init) => ((seen = init?.headers), { ok: true, json: async () => ({ data: [] }) }));
    expect(seen).toEqual({});
  });
});

describe("triggerFor", () => {
  const model = { provider: "p", id: "m", contextWindow: 128_000 };

  it("a threshold pass measures omp's trigger and later passes reuse it", () => {
    const state = createCompactionState();
    const w = windowOf(model);
    expect(triggerFor(w, state, "p/m", "threshold", 90_000)).toBe(90_000);
    expect(triggerFor(w, state, "p/m", "manual", 40_000)).toBe(90_000);
    // Another model: omp's default for its window.
    expect(triggerFor(windowOf({ ...model, id: "n" }), state, "p/n", "manual", 40_000)).toBe(108_800);
  });

  it("an overflow pass is bounded by the context that overflowed", () => {
    expect(triggerFor(windowOf(model), createCompactionState(), "p/m", "overflow", 30_000)).toBe(30_000);
  });

  it("omp's policy, as its compactions carry it, places the trigger, for that model only", () => {
    const state = createCompactionState();
    const w = windowOf(model);
    expect(triggerFor(w, state, "p/m", "threshold", 70_000, { thresholdPercent: 50 })).toBe(64_000);
    // A later pass without one (a /omp-vcc) keeps it; another model does not.
    expect(triggerFor(w, state, "p/m", "manual", 40_000)).toBe(64_000);
    expect(triggerFor(windowOf({ ...model, id: "n" }), state, "p/n", "manual", 40_000)).toBe(108_800);
    expect(triggerFor(w, createCompactionState(), "p/m", "manual", 40_000, { thresholdTokens: 90_000 })).toBe(90_000);
    expect(triggerFor(w, createCompactionState(), "p/m", "overflow", 30_000, { thresholdTokens: 90_000 })).toBe(30_000);
  });

  it("when a smaller real window is known, omp's trigger is above it and omp-vcc's own applies", () => {
    recordLearnedWindow("p/m", 32_768);
    const w = windowOf(model);
    expect(w).toMatchObject({ omp: 128_000, learned: 32_768, effective: 32_768, source: "overflow-error" });
    expect(triggerFor(w, createCompactionState(), "p/m", "threshold", 100_000)).toBe(16_384);
    // The user's own policy, on the real window: 80% of it, and a fixed 90K past it falls back as omp's does.
    expect(triggerFor(w, createCompactionState(), "p/m", "threshold", 100_000, { thresholdPercent: 80 })).toBe(26_214);
    expect(triggerFor(w, createCompactionState(), "p/m", "threshold", 100_000, { thresholdTokens: 90_000 })).toBe(16_384);
  });
});
