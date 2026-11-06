import { describe, it, expect } from "bun:test";
import { normalizeToolParams, parseCommandRequest, parseToolRequest } from "../src/core/recall-request";

describe("the scope of a recall call", () => {
  it("is lineage unless a call says all or project, in any case", () => {
    expect(parseToolRequest(normalizeToolParams({ query: "x" }) as any).scope).toBe("lineage");
    expect(parseToolRequest(normalizeToolParams({ query: "x", scope: "ALL" }) as any).scope).toBe("all");
    expect(parseToolRequest(normalizeToolParams({ query: "x", mode: "project" }) as any).scope).toBe("project");
  });

  it("is a token the command takes out of the query", () => {
    expect(parseCommandRequest("license scope:all page:2")).toEqual({ scope: "all", action: { kind: "search", query: "license", page: 2 } });
    expect(parseCommandRequest("license page:2")).toEqual({ scope: "lineage", action: { kind: "search", query: "license", page: 2 } });
  });

  it("with a session, project is named as ignored on either surface", () => {
    const fromTool = parseToolRequest(normalizeToolParams({ query: "x", scope: "project", session: "@abcd" }) as any);
    const fromCommand = parseCommandRequest("x scope:project session:abcd");
    for (const r of [fromTool, fromCommand]) {
      expect(r).toMatchObject({ scope: "lineage", session: "abcd" });
      expect(r.ignored?.map((i) => i.param)).toEqual(["scope"]);
    }
  });
});
