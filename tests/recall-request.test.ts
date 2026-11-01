import { describe, it, expect } from "bun:test";
import { parseToolRequest } from "../src/core/recall-request";
import { ignoredNote } from "../src/core/recall-run";

describe("parseToolRequest", () => {
  it("does not report filler defaults as ignored", () => {
    const r = parseToolRequest({ query: "auth", page: 1, expand: [], mode: "hybrid", scope: "lineage" });
    expect(r.action.kind).toBe("search");
    expect(r.ignored).toBeUndefined();
    expect(ignoredNote(r)).toBe("");
  });

  // 0f00af1: expand next to query was once silently turned into a search;
  // now expand wins and the dropped query is named.
  it("names the query dropped by expand", () => {
    const r = parseToolRequest({ query: "auth", expand: [4], page: 2 });
    expect(r.action).toEqual({ kind: "expand", indices: [4] });
    expect(ignoredNote(r)).toBe("Ignored: query, page (expand runs alone; send the rest in a separate call).\n\n");
  });

  it("keeps page for range and names the query", () => {
    const r = parseToolRequest({ range: [10, 50], page: 2, query: "auth" });
    expect(r.action).toEqual({ kind: "range", range: [10, 50], page: 2 });
    expect(r.ignored).toEqual(["query"]);
  });

  it("names everything touched does not use", () => {
    const r = parseToolRequest({ mode: "touched", query: "x", expand: [1], page: 2 });
    expect(r.action.kind).toBe("touched");
    expect(r.ignored).toEqual(["query", "expand"]);
  });

  it("names page without anything to page", () => {
    const r = parseToolRequest({ page: 3 });
    expect(r.action.kind).toBe("recent");
    expect(ignoredNote(r)).toBe("Ignored: page (page applies to query or range results).\n\n");
  });
});

import { normalizeToolParams } from "../src/core/recall-request";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { registerRecallTool } from "../src/tools/recall";

describe("normalizeToolParams", () => {
  it("repairs mistakes whose meaning is certain", () => {
    expect(normalizeToolParams({ expand: ["459", "#460", 461] })).toEqual({ expand: [459, 460, 461] });
    expect(normalizeToolParams({ expand: 459 })).toEqual({ expand: [459] });
    expect(normalizeToolParams({ expand: "#12, #15" })).toEqual({ expand: [12, 15] });
    expect(normalizeToolParams({ range: "10-20" })).toEqual({ range: [10, 20] });
    expect(normalizeToolParams({ range: "#10..#20" })).toEqual({ range: [10, 20] });
    expect(normalizeToolParams({ range: ["20", 10] })).toEqual({ range: [10, 20] });
    for (const range of [[5], 5, "#5", "5"]) expect(normalizeToolParams({ range })).toEqual({ range: [5, 5] });
    expect(normalizeToolParams({ page: "2" })).toEqual({ page: 2 });
    expect(normalizeToolParams({ scope: " ALL ", mode: "Touched" })).toEqual({ scope: "all", mode: "touched" });
    // seen in a real session: pi rejected the whole call
    expect(normalizeToolParams({ query: "jpeg flag", mode: "all" })).toEqual({ query: "jpeg flag", scope: "all" });
  });

  it("drops what it cannot repair and says so", () => {
    const p = normalizeToolParams({ query: "x", limit: 20, range: [5, 6, 7], expand: "the auth one", scope: "branch", page: 0 });
    expect(p).toEqual({
      query: "x",
      _vccDropped: [
        'limit 20 (not a vcc_recall param)',
        'page 0 (not a page number)',
        'expand "the auth one" (not #N indices)',
        "range [5,6,7] (not [from, to])",
        'scope "branch" (use \'lineage\', \'all\' or \'project\')',
      ],
    });
    const r = parseToolRequest(p);
    expect(ignoredNote(r).startsWith("Ignored: limit 20 (not a vcc_recall param), page 0")).toBe(true);
  });

  it("leaves well-formed params untouched", () => {
    const args = { query: "auth", range: [1, 2], expand: [3], page: 2, scope: "all", mode: "touched" };
    expect(normalizeToolParams(args)).toEqual(args);
  });

  it("passes pi's own schema validation after repair", () => {
    let tool: any;
    registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
    const raw = { query: "jpeg", mode: "all", expand: "459", limit: 20 };
    expect(() => validateToolArguments(tool, { id: "1", name: "vcc_recall", arguments: raw } as any)).toThrow();
    const args = validateToolArguments(tool, { id: "1", name: "vcc_recall", arguments: tool.prepareArguments(raw) } as any);
    expect(args).toMatchObject({ query: "jpeg", scope: "all", expand: [459], _vccDropped: ["limit 20 (not a vcc_recall param)"] });
  });
});
