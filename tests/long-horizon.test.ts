// Long-horizon floor: a 60- and a 120-turn session with planted facts, compacted
// every 6 turns through the real hook (tests/support/long-horizon.ts). Numbers
// for the current code: bun run scripts/benchmark-long-horizon.ts
import { describe, expect, it } from "bun:test";
import { runLongHorizon } from "./support/long-horizon";
import { searchEntries, stemOf } from "../src/core/search-entries";
import { renderMessage } from "../src/core/render-entries";
import { recallOutputChars, RECALL_OUTPUT_CHARS } from "../src/core/recall-run";

describe("long-horizon session", () => {
  const runs = [runLongHorizon({ turns: 60, compactEvery: 6 }), runLongHorizon({ turns: 120, compactEvery: 6 })];

  for (const r of runs) {
    describe(`${r.turns} turns, ${r.compactions} compactions`, () => {
      const by = (kind: string) => r.needles.find((n) => n.kind === kind)!;

      it("vcc_recall finds every planted fact with a reworded query, on page 1", () => {
        expect(r.needles.filter((n) => n.recallRank == null).map((n) => n.kind)).toEqual([]);
      });

      it("the summary keeps the session's early constraint and a later spec", () => {
        expect(by("constraint").inSummary).toBe(true);
        expect(by("mid_request").inSummary).toBe(true);
      });

      it("the summary points at most facts (exact ref or a [History Index] range that names them)", () => {
        expect(r.needles.filter((n) => n.pointed).length).toBeGreaterThanOrEqual(5);
      });
    });
  }

  it("the summary stays bounded as compactions double", () => {
    const [short, long] = runs;
    expect(Math.max(...long.summaryChars)).toBeLessThan(Math.max(...short.summaryChars) * 1.15);
    expect(Math.max(...long.summaryChars)).toBeLessThan(9000);
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
