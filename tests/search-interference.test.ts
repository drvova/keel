// Near-duplicate hits push each other down (lisp/src/search.lisp
// with-interference): the quantum probability ranking principle's destructive
// interference between redundant results (Zuccon, Azzopardi and van
// Rijsbergen 2009; arXiv:2007.04357), so a page of five shows five things,
// not one test's output five times.
import { describe, expect, it } from "bun:test";
import { searchHits } from "./support/pairs";

const text = (t: string) => [{ type: "text", text: t }];
const run = (i: number) => ({ role: "toolResult", toolCallId: `r${i}`, toolName: "bash", isError: true,
  content: text(`bun test tests/billing\n1 fail: totals rounding in invoice ${i}\nexpected 10.05 got 10.04\n${"  at roundTotals (src/billing/totals.ts:42)\n".repeat(20)}`) });

describe("recall's ranking", () => {
  it("puts entries that say something else on the first page, ahead of the third copy of the same output", () => {
    const messages = [
      ...Array.from({ length: 6 }, (_, i) => run(i)),
      { role: "user", content: "The billing totals rounding must use banker's rounding, per finance." },
      { role: "assistant", content: text("Rounding in billing totals: switched roundTotals to Math.round on cents; the invoice test still fails on 10.05.") },
    ];
    const page = searchHits(messages, "billing totals rounding").slice(0, 5).map((h) => h.index);
    // The user's rule and the agent's note are not repeats of anything: both make the page.
    expect(page).toContain(6);
    expect(page).toContain(7);
    // And the copies that are still there are the earlier-ranked ones, not every one of them.
    expect(page.filter((i) => i < 6).length).toBeLessThanOrEqual(3);
  });

  it("leaves distinct hits in BM25's order", () => {
    const messages = [
      { role: "user", content: "redis cache decision: keep sessions in SQLite" },
      { role: "assistant", content: text("The redis cache was dropped: the deploy host has no redis.") },
      { role: "user", content: "and what about the cache warmup for search" },
    ];
    const hits = searchHits(messages, "redis cache").map((h) => h.index);
    expect(hits.slice(0, 2).sort()).toEqual([0, 1]);
  });
});
