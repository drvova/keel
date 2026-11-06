import { describe, it, expect } from "bun:test";
import { formatRecallOutput } from "../src/core/format-recall";
import type { RenderedEntry } from "../src/core/render-entries";

describe("formatRecallOutput", () => {
  it("shows no-match message with query", () => {
    const r = formatRecallOutput([], "xyz");
    expect(r).toContain('No matches for "xyz"');
  });

  it("shows no-entries message without query", () => {
    expect(formatRecallOutput([])).toContain("No entries");
  });

  it("formats entries with index and role", () => {
    const entries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "hello" },
    ];
    const r = formatRecallOutput(entries);
    expect(r).toContain("#0 [user] hello");
  });

  // Search passes its own header (count, page, scope); the query and each hit's snippet are added here.
  it("names the query after the header and shows a hit's snippet", () => {
    const hits = [{ index: 2, role: "assistant", summary: "Reading the log", snippet: "...(4 lines above)\nthe job is done" }];
    expect(formatRecallOutput(hits, "done", "1 matches")).toBe('1 matches for "done":\n\n#2 [assistant] ...(4 lines above)\nthe job is done');
  });
});
