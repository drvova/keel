// Session and tool shapes particular to omp: the `/clear` boundary, native-replay
// compactions, hashline edits, read selectors, and omp's extra message roles in
// recall.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import { applyTailBudget, buildOwnCut, registerHook } from "./support/host";
import { callKind, fileWriteOf, namedPaths, readsPart, stripReadSelector, writtenText } from "../src/core/tools";
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
    expect(namedPaths({ input: hashline })).toEqual(["src/auth/session.ts", "lib/util.py"]);
    expect(namedPaths({ input: "[not a header] text" })).toEqual([]);
    // A path argument still wins.
    expect(namedPaths({ path: "a.ts", input: hashline })).toEqual(["a.ts"]);
  });

  test("an apply_patch edit names the files of its headers", () => {
    const patch = "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@\n-a\n+b\n*** Delete File: old.txt\n*** End Patch\n";
    expect(namedPaths({ input: patch })).toEqual(["hello.txt", "src/app.py", "src/main.py", "old.txt"]);
    expect(callKind({ name: "edit", args: { input: patch } })).toBe("edit");
  });

  test("a read of lines is a read of part of the file; :raw and a whole read are not", () => {
    const read = (path: string) => readsPart({ name: "read", args: { path } });
    for (const p of ["src/a.ts:50-100", "src/a.ts:L50-L60", "src/a.ts:-20", "src/a.ts:1-12,-15", "src/a.ts:raw:50-100", "src/a.ts:50+10"]) expect(read(p)).toBe(true);
    for (const p of ["src/a.ts", "src/a.ts:raw", "src/a.ts:img", "db.sqlite:table"]) expect(read(p)).toBe(false);
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

describe("omp's replace edit (old_string/new_string)", () => {
  const edit: any = { role: "assistant", content: [{ type: "toolCall", id: "t", name: "edit", arguments: { path: "src/money.ts", old_string: "floor + 1 : floor", new_string: "floor : floor + 1" } }] };

  test("is a change: listed and drillable in mode:'touched', its text searchable", () => {
    const call = { name: "edit", args: edit.content[0].arguments };
    expect(fileWriteOf(call)).toEqual({ path: "src/money.ts", replace: { oldText: "floor + 1 : floor", newText: "floor : floor + 1" } });
    expect(writtenText(call.args)).toBe("floor + 1 : floor\nfloor : floor + 1\n");
    const touched = getTouchedFiles([edit], [{ index: 4, role: "assistant", summary: "" }]);
    expect(touched[0].entries).toEqual([{ index: 4, toolName: "edit" }]);
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
  const previous = process.env.OMP_VCC_CONFIG_PATH;
  afterEach(() => {
    if (previous === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
    else process.env.OMP_VCC_CONFIG_PATH = previous;
    setSettingsAgentDir();
  });

  test("the entry point's agent dir, unless OMP_VCC_CONFIG_PATH is set", () => {
    delete process.env.OMP_VCC_CONFIG_PATH;
    setSettingsAgentDir(() => join(homedir(), ".omp", "agent"));
    expect(settingsPath()).toBe(join(homedir(), ".omp", "agent", "omp-vcc-config.json"));
    process.env.OMP_VCC_CONFIG_PATH = "/tmp/elsewhere.json";
    expect(settingsPath()).toBe("/tmp/elsewhere.json");
  });
});

describe("a turn still running", () => {
  const prev = process.env.OMP_VCC_CONFIG_PATH;
  afterEach(() => {
    if (prev === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
    else process.env.OMP_VCC_CONFIG_PATH = prev;
  });

  test("a threshold pass between tool calls waits; a recovery pass is answered by omp-vcc", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-running-"));
    process.env.OMP_VCC_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
    let handler: any;
    const hook = registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    const entries = [
      msg("u1", "user", "Run the tests"),
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun test" } }] } },
      { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "12 pass" }], isError: false } },
    ];
    const event = (reason: "threshold" | "overflow") => (hook.autoCompactionStart(reason), {
      type: "session_before_compact", branchEntries: entries, customInstructions: undefined,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
      signal: new AbortController().signal,
    });
    const ctx = { ui: { notify: () => {} } };
    expect(handler(event("threshold"), ctx)).toEqual({ cancel: true });
    // Recovering, omp-vcc answers itself (omp would run snapcompact, handoff or an
    // LLM summary otherwise). One step is more than half the turn, so the turn is
    // summarized whole, the request with it.
    const recovered = handler(event("overflow"), ctx).compaction;
    expect(recovered.firstKeptEntryId).toBe("");
    expect(recovered.summary).toContain("Run the tests");
  });

  test("a recovery pass on a longer running turn within the tail budget keeps its newest steps, at most half of it", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-running-"));
    process.env.OMP_VCC_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
    let handler: any;
    const hook = registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    const step = (i: number) => [
      { id: `a${i}`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `cat part${i}.log` } }] } },
      { id: `r${i}`, type: "message", message: { role: "toolResult", toolCallId: `t${i}`, toolName: "bash", content: [{ type: "text", text: `part ${i}: ${"log line\n".repeat(20)}` }], isError: false } },
    ];
    const steps = Array.from({ length: 12 }, (_, i) => i + 1);
    const entries = [msg("u1", "user", "Find which part of the log has the timeout"), ...steps.flatMap(step)];
    hook.autoCompactionStart("overflow");
    const { compaction } = handler({
      type: "session_before_compact", branchEntries: entries, customInstructions: undefined,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 800 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} } });
    // The newest steps are kept, starting at a call (never at a result), no more
    // than half the turn; the request and the earlier steps are summarized.
    const kept = entries.findIndex((e) => e.id === compaction.firstKeptEntryId);
    expect(kept).toBeGreaterThanOrEqual(Math.ceil(entries.length / 2));
    expect(kept).toBeLessThan(entries.length - 1);
    expect(entries[kept].message.role).toBe("assistant");
    expect(compaction.summary).toContain("Find which part of the log has the timeout");
    expect(compaction.details).toMatchObject({ compactor: "omp-vcc", reason: "overflow" });
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
    expect(cut).toMatchObject({ ok: true, compactAll: false, firstKeptEntryId: "f1", budgetCut: "final_reply", selectedIds: ["u1", "a1", "r1"] });
  });

  test("a budget cut that keeps only a finished turn's reply says so", () => {
    const long = (id: string) => ({ id, type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "y".repeat(40_000) }], isError: false } });
    const entries = [msg("u1", "user", "Run it"), callAndResult[0], long("r1"), msg("f1", "assistant", "done, 20")];
    expect(applyTailBudget(entries, buildOwnCut(entries, 1), { maxTokens: 1_000, charsPerToken: 4 })).toMatchObject({ ok: true, firstKeptEntryId: "f1", budgetCut: "final_reply" });
  });

  test("a turn ending in a tool call keeps the old compact-all", () => {
    const nextCall = { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "seq 1 30" } }] } };
    const entries = [msg("u1", "user", "Run seq 1 20"), ...callAndResult, nextCall];
    expect(applyTailBudget(entries, buildOwnCut(entries, 1))).toMatchObject({ ok: true, compactAll: true });
  });
});
