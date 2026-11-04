// Long-horizon floor: 60- and 120-turn sessions with planted facts, worked through
// by a real model in omp with omp-vcc loaded, omp's idle pass every 6 turns
// (tests/support/long-horizon.ts). Numbers for the current code:
// bun run scripts/benchmark-long-horizon.ts
import { beforeAll, describe, expect, it } from "bun:test";
import { realModel, runLongHorizon, type LongHorizonResult } from "./support/long-horizon";
import { searchEntries, stemOf } from "../src/core/search-entries";
import { renderMessage } from "../src/core/render-entries";
import { recallOutputChars, RECALL_OUTPUT_CHARS } from "../src/core/recall-run";

// Each run is a real model working in omp, a turn at a time: minutes per run. Without a
// model in the environment (see tests/support/long-horizon.ts) these are skipped.
const PIN = "Sessions are stored in SQLite rather than Redis: the deploy host has no Redis.";
describe.skipIf(!realModel())("long-horizon session, on a real model in omp", () => {
  const runs: Record<string, LongHorizonResult> = {};
  beforeAll(async () => {
    runs.r60 = await runLongHorizon({ turns: 60, compactEvery: 6 });
    runs.r120 = await runLongHorizon({ turns: 120, compactEvery: 6, pins: { 9: PIN } });
    runs.small = await runLongHorizon({ turns: 60, compactEvery: 6, contextWindow: 32_768 });
    runs.large = await runLongHorizon({ turns: 60, compactEvery: 6, contextWindow: 1_000_000 });
  }, 4 * 60 * 60_000);
  const count = (r: LongHorizonResult, key: "inSummary" | "pointed") => r.needles.filter((n) => n[key]).length;

  for (const [key, turns] of [["r60", 60], ["r120", 120]] as const) {
    describe(`${turns} turns`, () => {
      const r = () => runs[key];
      const by = (kind: string) => r().needles.find((n) => n.kind === kind)!;

      it("omp compacted at least every 6 turns, through omp-vcc each time", () => {
        expect(r().compactions).toBeGreaterThanOrEqual(turns / 6);
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
        expect(count(r(), "pointed")).toBeGreaterThanOrEqual(5);
      });
    });
  }

  it("the summary stays bounded as compactions double", () => {
    expect(Math.max(...runs.r120.summaryChars)).toBeLessThan(Math.max(...runs.r60.summaryChars) * 1.15);
    expect(Math.max(...runs.r120.sectionChars)).toBeLessThan(10_000);
  });

  it("a note pinned at turn 9 leads the summary after every compaction", () => {
    expect(runs.r120.finalSummary.startsWith(`[Pinned Notes]\n- [1] ${PIN} (agent`)).toBe(true);
  });

  // The same 60-turn session on a 32K and a 1M window: budgets and section sizes
  // follow omp's trigger (core/window.ts), recall and pointers do not.
  it("a 32K window gets about half the summary's sections, and keeps every pointer and recall", () => {
    const { small, r60: typical } = runs;
    expect(small.byOmpVcc).toBe(small.compactions);
    // [Working Set] is sized from what the compaction may land with, not with the sections.
    const sections = (r: LongHorizonResult) => Math.max(...r.sectionChars);
    expect(sections(small)).toBeLessThan(sections(typical) * 0.6);
    expect(count(small, "pointed")).toBeGreaterThanOrEqual(count(typical, "pointed"));
    expect(small.needles.filter((n) => n.recallRank == null)).toEqual([]);
    expect(small.needles.filter((n) => n.kind === "constraint" || n.kind === "mid_request").every((n) => n.inSummary)).toBe(true);
  });

  it("a 1M window keeps at least as many facts in the summary itself, its sections still bounded", () => {
    const { large, r60: typical } = runs;
    expect(count(large, "inSummary")).toBeGreaterThanOrEqual(count(typical, "inSummary"));
    expect(Math.max(...large.sectionChars)).toBeLessThan(16_000);
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
