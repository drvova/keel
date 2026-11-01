// Session and tool shapes that only omp writes, handled in the shared code: the
// `/clear` boundary, native-replay compactions, hashline edits, read selectors,
// and omp's extra message roles in recall.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import { applyTailBudget, buildOwnCut } from "../src/hooks/before-compact";
import { extractPaths, hashlineEditPaths, stripReadSelector } from "../src/core/tool-args";
import { extractFiles } from "../src/extract/files";
import { renderMessage } from "../src/core/render-entries";
import { getTouchedFiles } from "../src/core/search-entries";
import { setSettingsAgentDir, settingsPath } from "../src/core/settings";

const msg = (id: string, role: "user" | "assistant", content = `text of ${id}`) => ({
  id,
  type: "message",
  message: role === "assistant" ? { role, content: [{ type: "text", text: content }] } : { role, content },
});
const comp = (id: string, firstKeptEntryId: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: "compaction", firstKeptEntryId, summary: "s", tokensBefore: 1, ...extra });
const reset = (id: string) => ({ id, type: "reset_boundary" });

const selectedIds = (entries: any[], keep = 0) => {
  const cut = buildOwnCut(entries, keep);
  if (!cut.ok) throw new Error(`no cut: ${cut.reason}`);
  return cut.selectedIds;
};

describe("live window: omp /clear (reset_boundary)", () => {
  test("a reset after everything else starts the window after it", () => {
    const entries = [msg("a1", "user"), msg("a2", "assistant"), reset("r"), msg("b1", "user"), msg("b2", "assistant"), msg("b3", "user")];
    expect(selectedIds(entries)).toEqual(["b1", "b2", "b3"]);
  });

  test("a reset after the latest compaction wins over that compaction's kept tail", () => {
    const entries = [
      msg("a1", "user"), msg("a2", "assistant"), msg("a3", "user"), comp("c", "a3"),
      reset("r"), msg("b1", "user"), msg("b2", "assistant"), msg("b3", "user"),
    ];
    expect(selectedIds(entries)).toEqual(["b1", "b2", "b3"]);
  });

  test("a compaction after the reset keeps its own tail", () => {
    const entries = [
      msg("a1", "user"), reset("r"), msg("b1", "user"), msg("b2", "assistant"), msg("b3", "user"),
      comp("c", "b2"), msg("b4", "assistant"), msg("b5", "user"),
    ];
    expect(selectedIds(entries)).toEqual(["b2", "b3", "b4", "b5"]);
  });
});

describe("live window: omp native-replay compaction", () => {
  test("an empty kept id with providerReplayThroughEntryId resumes after that entry", () => {
    const entries = [
      msg("a1", "user"), msg("a2", "assistant"), msg("a3", "user"), msg("a4", "assistant"),
      comp("c", "", { providerReplayThroughEntryId: "a2" }), msg("b1", "user"),
    ];
    expect(selectedIds(entries)).toEqual(["a3", "a4", "b1"]);
  });

  test("without it, orphan recovery still starts after the compaction", () => {
    const entries = [msg("a1", "user"), msg("a2", "assistant"), comp("c", ""), msg("b1", "user"), msg("b2", "assistant"), msg("b3", "user")];
    expect(selectedIds(entries)).toEqual(["b1", "b2", "b3"]);
  });
});

describe("omp tool shapes", () => {
  const hashline = "*** Begin Patch\n[src/auth/session.ts#1A2B]\nPUT 4.=4:\n+x\n[lib/util.py#3c4d]\nCUT 1.=2\n*** End Patch";

  test("a hashline edit names the files of its [PATH#TAG] sections", () => {
    expect(hashlineEditPaths({ input: hashline })).toEqual(["src/auth/session.ts", "lib/util.py"]);
    expect(extractPaths({ input: hashline })).toEqual(["src/auth/session.ts", "lib/util.py"]);
    expect(hashlineEditPaths({ input: "[not a header] text" })).toEqual([]);
    // A path argument still wins.
    expect(extractPaths({ path: "a.ts", input: hashline })).toEqual(["a.ts"]);
  });

  test("read selectors are dropped, other colons kept", () => {
    expect(stripReadSelector("src/a.ts:50-100")).toBe("src/a.ts");
    expect(stripReadSelector("src/a.ts:raw")).toBe("src/a.ts");
    expect(stripReadSelector("src/a.ts:-20")).toBe("src/a.ts");
    expect(stripReadSelector("src/a.ts:1-12,-15")).toBe("src/a.ts");
    expect(stripReadSelector("db.sqlite:table")).toBe("db.sqlite:table");
    expect(stripReadSelector("src/a.ts")).toBe("src/a.ts");
  });

  test("[Files And Changes] lists a file read with a selector once, and an edited file", () => {
    const blocks: any[] = [
      { kind: "tool_call", name: "read", args: { path: "src/auth/session.ts:1-80" } },
      { kind: "tool_call", name: "read", args: { path: "src/auth/session.ts:81-160" } },
      { kind: "tool_call", name: "edit", args: { input: hashline } },
    ];
    const files = extractFiles(blocks);
    expect([...files.read]).toEqual(["src/auth/session.ts"]);
    expect([...files.modified].sort()).toEqual(["lib/util.py", "src/auth/session.ts"]);
  });

  test("mode:'touched' lists a hashline edit's files, not drillable", () => {
    const edit: any = { role: "assistant", content: [{ type: "toolCall", id: "t", name: "edit", arguments: { input: hashline } }] };
    const touched = getTouchedFiles([edit], [{ index: 7, role: "assistant", summary: "" }]);
    expect(touched.map((t) => t.path).sort()).toEqual(["lib/util.py", "src/auth/session.ts"]);
    expect(touched[0].entries).toEqual([{ index: 7, toolName: "edit", drillable: false }]);
  });
});

describe("recall rendering of omp roles", () => {
  test("a python cell renders like a user-run command", () => {
    const r = renderMessage({ role: "pythonExecution", code: "print(1)", output: "1" } as any, 3);
    expect(r).toEqual({ index: 3, role: "python", summary: ">>> print(1)\n1" });
  });

  test("an @file mention renders its paths, not the file bodies", () => {
    const r = renderMessage({ role: "fileMention", files: [{ path: "notes.md", content: "BODY" }] } as any, 4);
    expect(r).toEqual({ index: 4, role: "file", summary: "@notes.md", files: ["notes.md"] });
  });

  test("developer and custom messages keep their role", () => {
    expect(renderMessage({ role: "developer", content: "reminder" } as any, 5).role).toBe("developer");
    expect(renderMessage({ role: "custom", content: "card" } as any, 6).role).toBe("custom");
  });
});

describe("settings path follows the host's agent dir", () => {
  const previous = process.env.PI_VCC_CONFIG_PATH;
  afterEach(() => {
    if (previous === undefined) delete process.env.PI_VCC_CONFIG_PATH;
    else process.env.PI_VCC_CONFIG_PATH = previous;
    setSettingsAgentDir();
  });

  test("the entry point's agent dir, unless PI_VCC_CONFIG_PATH is set", () => {
    delete process.env.PI_VCC_CONFIG_PATH;
    setSettingsAgentDir(() => join(homedir(), ".omp", "agent"));
    expect(settingsPath()).toBe(join(homedir(), ".omp", "agent", "pi-vcc-config.json"));
    process.env.PI_VCC_CONFIG_PATH = "/tmp/elsewhere.json";
    expect(settingsPath()).toBe("/tmp/elsewhere.json");
  });
});

describe("Pi host: a turn still running", () => {
  const prev = process.env.PI_VCC_CONFIG_PATH;
  afterEach(() => {
    if (prev === undefined) delete process.env.PI_VCC_CONFIG_PATH;
    else process.env.PI_VCC_CONFIG_PATH = prev;
  });

  test("an automatic pass between tool calls is left alone when compact-all is the only cut", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-running-"));
    process.env.PI_VCC_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.PI_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
    const { registerBeforeCompactHook } = await import("../src/hooks/before-compact");
    let handler: any;
    registerBeforeCompactHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } } as any, "1.1.0");
    const entries = [
      msg("u1", "user", "Run the tests"),
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun test" } }] } },
      { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "12 pass" }], isError: false } },
    ];
    const event = (reason: string, willRetry: boolean) => ({
      type: "session_before_compact", branchEntries: entries, customInstructions: undefined, reason, willRetry,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
      signal: new AbortController().signal,
    });
    const ctx = { ui: { notify: () => {} } };
    expect(handler(event("threshold", false), ctx)).toEqual({ cancel: true });
    expect(handler(event("overflow", true), ctx)).toBeUndefined();
  });
});

describe("no user anchor, whole window under the tail budget", () => {
  const callAndResult = [
    { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "seq 1 20" } }] } },
    { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "1..20" }], isError: false } },
  ];

  test("a finished turn keeps its final answer and summarizes the rest", () => {
    const entries = [msg("u1", "user", "Run seq 1 20, tell me the last number"), ...callAndResult, msg("f1", "assistant", "20")];
    const cut = applyTailBudget(entries, buildOwnCut(entries, 1));
    expect(cut).toMatchObject({ ok: true, compactAll: false, firstKeptEntryId: "f1", budgetCut: "no_anchor", selectedIds: ["u1", "a1", "r1"] });
  });

  test("a turn ending in a tool call keeps the old compact-all", () => {
    const nextCall = { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "seq 1 30" } }] } };
    const entries = [msg("u1", "user", "Run seq 1 20"), ...callAndResult, nextCall];
    expect(applyTailBudget(entries, buildOwnCut(entries, 1))).toMatchObject({ ok: true, compactAll: true });
  });
});
