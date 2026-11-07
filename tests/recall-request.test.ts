import { ompBinding } from "./support/binding";
import { describe, it, expect } from "bun:test";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { registerRecallTool } from "../src/tools/recall";
import { core } from "../src/core/lisp-core";

// A recall call's params, or a command's text, as the core reads them (lisp/src/request.lisp, op request).
interface Request { scope: string; session?: string; action: { kind: string } & Record<string, unknown>; ignored: string[]; note: string }
const read = (r: Record<string, any>): Request => ({ ...r.request, note: r.note });
const parseToolRequest = (params: unknown): Request => read(core({ op: "request", params }));
const parseCommandRequest = (args: string): Request => read(core({ op: "request", args }));
const ignoredNote = (r: Request): string => r.note;
const normalizeToolParams = (params: unknown): { params: Record<string, unknown>; dropped: string[] } => {
  const r = core({ op: "request", params });
  return { params: r.params as Record<string, unknown>, dropped: r.dropped as string[] };
};

describe("the tool's params read as a request", () => {
  it("does not report filler defaults as ignored", () => {
    const r = parseToolRequest({ query: "auth", page: 1, expand: [], mode: "hybrid", scope: "lineage" });
    expect(r.action.kind).toBe("search");
    expect(r.ignored).toEqual([]);
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
    expect(ignoredNote(r)).toBe("Ignored: page (page applies to a query, a range, touched or sessions).\n\n");
  });

  it("with a session, project is named as ignored on either surface", () => {
    const fromTool = parseToolRequest({ query: "x", scope: "project", session: "@abcd" });
    const fromCommand = parseCommandRequest("x scope:project session:abcd");
    for (const r of [fromTool, fromCommand]) {
      expect(r).toMatchObject({ scope: "lineage", session: "abcd" });
      expect(r.ignored).toEqual(["scope"]);
    }
  });
});

describe("the command's text read as a request", () => {
  it("takes scope:, session: and page: out of the query, and lists the sessions for 'sessions' alone", () => {
    expect(parseCommandRequest("license scope:all page:2")).toMatchObject({ scope: "all", action: { kind: "search", query: "license", page: 2 }, ignored: [] });
    expect(parseCommandRequest("license page:2")).toMatchObject({ scope: "lineage", action: { kind: "search", query: "license", page: 2 }, ignored: [] });
    expect(parseCommandRequest("rolled back scope:project")).toMatchObject({ scope: "project", action: { kind: "search", query: "rolled back" } });
    expect(parseCommandRequest("session:aaaa1111 rolled back")).toMatchObject({ session: "aaaa1111", action: { kind: "search", query: "rolled back" } });
    expect(parseCommandRequest("sessions").action).toEqual({ kind: "sessions", page: 1 });
  });
});

describe("the tool's params repaired", () => {
  it("repairs mistakes whose meaning is certain", () => {
    expect(normalizeToolParams({ expand: ["459", "#460", 461] }).params).toEqual({ expand: [459, 460, 461] });
    expect(normalizeToolParams({ expand: 459 }).params).toEqual({ expand: [459] });
    expect(normalizeToolParams({ expand: "#12, #15" }).params).toEqual({ expand: [12, 15] });
    expect(normalizeToolParams({ range: "10-20" }).params).toEqual({ range: [10, 20] });
    expect(normalizeToolParams({ range: "#10..#20" }).params).toEqual({ range: [10, 20] });
    expect(normalizeToolParams({ range: ["20", 10] }).params).toEqual({ range: [10, 20] });
    for (const range of [[5], 5, "#5", "5"]) expect(normalizeToolParams({ range }).params).toEqual({ range: [5, 5] });
    expect(normalizeToolParams({ page: "2" }).params).toEqual({ page: 2 });
    expect(normalizeToolParams({ scope: " ALL ", mode: "Touched" }).params).toEqual({ scope: "all", mode: "touched" });
    // seen in a real session: pi rejected the whole call
    expect(normalizeToolParams({ query: "jpeg flag", mode: "all" }).params).toEqual({ query: "jpeg flag", scope: "all" });
  });

  it("drops what it cannot repair and says so", () => {
    const raw = { query: "x", limit: 20, range: [5, 6, 7], expand: "the auth one", scope: "branch", page: 0 };
    expect(normalizeToolParams(raw)).toEqual({
      params: { query: "x" },
      dropped: [
        'limit 20 (not a vcc_recall param)',
        'page 0 (not a page number)',
        'expand "the auth one" (not #N indices)',
        "range [5,6,7] (not [from, to])",
        'scope "branch" (use \'lineage\', \'all\' or \'project\')',
      ],
    });
    const r = parseToolRequest(raw);
    expect(ignoredNote(r).startsWith("Ignored: limit 20 (not a vcc_recall param), page 0")).toBe(true);
  });

  it("reads a param sent empty as not sent, with no Ignored: note", () => {
    expect(normalizeToolParams({ query: "auth", range: [], scope: "", mode: " ", session: "", expand: null })).toEqual({ params: { query: "auth" }, dropped: [] });
  });

  it("leaves well-formed params untouched", () => {
    const args = { query: "auth", range: [1, 2], expand: [3], page: 2, scope: "all", mode: "touched" };
    expect(normalizeToolParams(args).params).toEqual(args);
  });

  it("omp's own validator lets the loose forms through, for normalizeToolParams to repair", () => {
    let tool: any;
    registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any, ompBinding);
    const raw = { query: "jpeg", mode: "all", expand: "459", limit: 20 };
    const args = validateToolArguments(tool, { id: "1", name: "vcc_recall", arguments: raw } as any);
    expect(normalizeToolParams(args)).toMatchObject({ params: { query: "jpeg", scope: "all", expand: [459] }, dropped: ["limit 20 (not a vcc_recall param)"] });
    // A shape no repair could read still fails omp's check before execute().
    expect(() => validateToolArguments(tool, { id: "1", name: "vcc_recall", arguments: { range: { from: 1 } } } as any)).toThrow();
  });
});
