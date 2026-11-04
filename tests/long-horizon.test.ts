// Long-horizon floor: a 60- and a 120-turn session with planted facts, run by omp
// itself with omp-vcc loaded, omp's idle pass every 6 turns
// (tests/support/long-horizon.ts). Numbers for the current code:
// bun run scripts/benchmark-long-horizon.ts
import { beforeAll, describe, expect, it } from "bun:test";
import { runLongHorizon, type LongHorizonResult } from "./support/long-horizon";
import { searchEntries, stemOf } from "../src/core/search-entries";
import { renderMessage } from "../src/core/render-entries";
import { recallOutputChars, RECALL_OUTPUT_CHARS } from "../src/core/recall-run";

describe("long-horizon session", () => {
  // Run by omp itself (tests/support/long-horizon.ts): one session at a time, they share the process env.
  const runs: LongHorizonResult[] = [];
  beforeAll(async () => {
    runs.push(await runLongHorizon({ turns: 60, compactEvery: 6 }));
    runs.push(await runLongHorizon({ turns: 120, compactEvery: 6 }));
  }, 180_000);

  for (const [i, turns] of [[0, 60], [1, 120]] as const) {
    describe(`${turns} turns`, () => {
      const r = () => runs[i];
      const by = (kind: string) => r().needles.find((n) => n.kind === kind)!;

      it("omp compacted every 6 turns, through omp-vcc each time", () => {
        expect(r().compactions).toBe(turns / 6);
        expect(r().byOmpVcc).toBe(r().compactions);
      });

      it("vcc_recall finds every planted fact with a reworded query, on page 1", () => {
        expect(r().needles.filter((n) => n.recallRank == null).map((n) => n.kind)).toEqual([]);
      });

      it("the summary keeps the session's early constraint and a later spec", () => {
        expect(by("constraint").inSummary).toBe(true);
        expect(by("mid_request").inSummary).toBe(true);
      });

      it("the summary points at most facts (exact ref or a [History Index] range that names them)", () => {
        expect(r().needles.filter((n) => n.pointed).length).toBeGreaterThanOrEqual(5);
      });
    });
  }

  it("the summary stays bounded as compactions double", () => {
    const [short, long] = runs;
    expect(Math.max(...long.summaryChars)).toBeLessThan(Math.max(...short.summaryChars) * 1.15);
    expect(Math.max(...long.summaryChars)).toBeLessThan(10_000);
  });
});

// The same 120-turn session on a 32K, a 128K and a 1M window: budgets and
// section sizes follow omp's trigger on it (core/window.ts), recall and pointers do not.
describe("long-horizon session: the summary follows the window", () => {
  const byWindow: Record<number, LongHorizonResult> = {};
  beforeAll(async () => {
    for (const contextWindow of [32_768, 128_000, 1_000_000]) byWindow[contextWindow] = await runLongHorizon({ turns: 120, compactEvery: 6, contextWindow });
  }, 240_000);
  const max = (r: LongHorizonResult) => Math.max(...r.summaryChars);
  const count = (r: LongHorizonResult, key: "inSummary" | "pointed") => r.needles.filter((n) => n[key]).length;

  it("a 32K window gets about half the summary's sections, and keeps every pointer and recall", () => {
    const [small, typical] = [byWindow[32_768], byWindow[128_000]];
    // With omp's system prompt and tools in it, omp also compacts a 32K window on its own, between the idle passes.
    expect(small.compactions).toBeGreaterThan(typical.compactions);
    expect(small.byOmpVcc).toBe(small.compactions);
    // [Working Set] is sized from what the compaction may land with, not with the sections.
    const sections = (r: LongHorizonResult) => Math.max(...r.sectionChars);
    expect(sections(small)).toBeLessThan(sections(typical) * 0.6);
    expect(count(small, "pointed")).toBeGreaterThanOrEqual(count(typical, "pointed"));
    expect(small.needles.filter((n) => n.recallRank == null)).toEqual([]);
    expect(small.needles.filter((n) => n.kind === "constraint" || n.kind === "mid_request").every((n) => n.inSummary)).toBe(true);
  });

  it("a 1M window keeps more facts in the summary itself, its sections still bounded", () => {
    const [typical, large] = [byWindow[128_000], byWindow[1_000_000]];
    expect(count(large, "inSummary")).toBeGreaterThan(count(typical, "inSummary"));
    expect(Math.max(...large.sectionChars)).toBeLessThan(16_000);
    // The working set on top stays within its own budget (6,460 tokens on a 1M window).
    expect(max(large) - Math.max(...large.sectionChars)).toBeLessThan(6_460 * 4);
  });
});

describe("recall search: inflected forms", () => {
  it("stems plain ASCII words, leaves short, non-ASCII and regex terms alone", () => {
    expect(stemOf("rounding")).toBe("round");
    expect(stemOf("failure")).toBe("fail");
    expect(stemOf("retries")).toBe("retr");
    // A doubled final consonant is undone only while the stem stays 4+ letters.
    expect(stemOf("running")).toBe("runn");
    expect(stemOf("committed")).toBe("commit");
    expect(stemOf("test")).toBeUndefined();
    expect(stemOf("缓存失败")).toBeUndefined();
    expect(stemOf("auth.*token")).toBeUndefined();
  });

  it("a query in another form of the word still finds the entry", () => {
    const msgs: any[] = [
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "FAIL tests/billing.test.ts > rounds totals" }] },
      { role: "user", content: "unrelated message about the docs" },
    ];
    const rendered = msgs.map((m, i) => renderMessage(m, i));
    expect(searchEntries(rendered, msgs, "rounding failure").map((h) => h.index)).toEqual([0]);
  });
});

describe("recall output ceiling", () => {
  it("is a tenth of the context window, between 8 KB and 50 KB", () => {
    expect(recallOutputChars(undefined)).toBe(RECALL_OUTPUT_CHARS);
    expect(recallOutputChars(200_000)).toBe(RECALL_OUTPUT_CHARS);
    expect(recallOutputChars(32_000)).toBe(12_800);
    expect(recallOutputChars(8_000)).toBe(8 * 1024);
  });
});
