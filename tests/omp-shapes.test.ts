// Session and tool shapes particular to omp: the `/clear` boundary, native-replay
// compactions, hashline edits, read selectors, and omp's extra message roles in
// recall.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import { applyTailBudget, buildOwnCut, registerHook } from "./support/host";
import { summarize } from "./support/summary";
import { recallOn } from "./support/pairs";

const msg = (id: string, role: "user" | "assistant", content = `text of ${id}`) => ({
  id,
  type: "message",
  message: role === "assistant" ? { role, content: [{ type: "text", text: content }] } : { role, content },
});
const comp = (id: string, firstKeptEntryId: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: "compaction", firstKeptEntryId, summary: "s", tokensBefore: 1, ...extra });
const reset = (id: string) => ({ id, type: "reset_boundary" });
const call = (args: Record<string, unknown>, name = "edit") => ({ role: "assistant", content: [{ type: "toolCall", id: "t", name, arguments: args }] });
/** The line a range shows of each message, by #N. */
const lines = (messages: unknown[]): string[] =>
  recallOn(messages, { range: [0, messages.length - 1] }).split("\n\n").slice(1).map((l) => l.replace(/^#\d+ /, ""));

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

  test("a hashline edit names the files of its [PATH#TAG] sections; a path argument still wins", () => {
    expect(lines([call({ input: hashline }), call({ input: "[not a header] text" }), call({ path: "a.ts", input: hashline })])).toEqual([
      "[assistant] files:[src/auth/session.ts, lib/util.py] edit(path=src/auth/session.ts +1)",
      "[assistant] edit(input)",
      "[assistant] files:[a.ts] edit(path=a.ts)",
    ]);
  });

  test("an apply_patch edit names the files of its headers, under either name", () => {
    const patch = "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@\n-a\n+b\n*** Delete File: old.txt\n*** End Patch\n";
    // On GPT-5 omp's edit goes on the wire, and into the session, as apply_patch.
    for (const name of ["edit", "apply_patch"]) {
      const { files } = summarize([{ kind: "tool_call", name, args: { input: patch } } as any]).state;
      expect([...files.modified, ...files.created].sort()).toEqual(["hello.txt", "old.txt", "src/app.py", "src/main.py"]);
    }
  });

  // A read of lines, and its selectors: lisp/test/tools.lisp.

  test("[Files And Changes] lists a file read with a selector once, and an edited file", () => {
    const blocks: any[] = [
      { kind: "tool_call", name: "read", args: { path: "src/auth/session.ts:1-80" } },
      { kind: "tool_call", name: "read", args: { path: "src/auth/session.ts:81-160" } },
      { kind: "tool_call", name: "edit", args: { input: hashline } },
    ];
    const { files } = summarize(blocks).state;
    expect(files.read).toEqual(["src/auth/session.ts"]);
    expect([...files.modified].sort()).toEqual(["lib/util.py", "src/auth/session.ts"]);
  });

  test("mode:'touched' lists a hashline edit's files, not drillable", () => {
    const out = recallOn([call({ input: hashline })], { mode: "touched" });
    expect(out).toContain("  src/auth/session.ts    #0 (edit)");
    expect(out).toContain("  lib/util.py    #0 (edit)");
    expect(out).not.toContain("File content at an entry");
  });
});

describe("omp's replace edit (old_string/new_string)", () => {
  const edit: any = { role: "assistant", content: [{ type: "toolCall", id: "t", name: "edit", arguments: { path: "src/money.ts", old_string: "floor + 1 : floor", new_string: "floor : floor + 1" } }] };

  test("is a change: listed and drillable in mode:'touched', its file content what it put in", () => {
    const out = recallOn([edit], { mode: "touched" });
    expect(out).toContain("  src/money.ts    #0 (edit)");
    expect(out).toContain("query:'#0:money.ts'");
    expect(recallOn([edit], { query: "#0:src/money.ts" })).toContain("floor : floor + 1");
  });
});

describe("recall rendering of omp roles", () => {
  test("a python cell renders like a user-run command, an @file mention by its paths, not the file bodies", () => {
    expect(lines([{ role: "pythonExecution", code: "print(1)", output: "1" }, { role: "fileMention", files: [{ path: "notes.md", content: "BODY" }] }]))
      .toEqual(["[python] >>> print(1)\n1", "[file] files:[notes.md] @notes.md"]);
  });

  test("developer and custom messages keep their role", () => {
    expect(lines([{ role: "developer", content: "reminder" }, { role: "custom", content: "card" }])).toEqual(["[developer] reminder", "[custom] card"]);
  });
});

describe("a turn still running", () => {
  const prev = process.env.KEEL_CONFIG_PATH;
  afterEach(() => {
    if (prev === undefined) delete process.env.KEEL_CONFIG_PATH;
    else process.env.KEEL_CONFIG_PATH = prev;
  });

  // The threshold pass on such a turn (it waits) is omp-entry.test.ts's "a threshold pass waits for the turn to end".
  test("a recovery pass on a running turn whose one step is over half of it summarizes the turn whole", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "keel-running-"));
    process.env.KEEL_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
    let handler: any;
    const hook = registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    const entries = [
      msg("u1", "user", "Run the tests"),
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun test" } }] } },
      { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "12 pass" }], isError: false } },
    ];
    hook.autoCompactionStart("overflow");
    const event = {
      type: "session_before_compact", branchEntries: entries, customInstructions: undefined,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
      signal: new AbortController().signal,
    };
    // Recovering, keel answers itself (omp would run snapcompact, handoff or an
    // LLM summary otherwise). One step is more than half the turn, so the turn is
    // summarized whole, the request with it.
    const recovered = handler(event, { ui: { notify: () => {} } }).compaction;
    expect(recovered.firstKeptEntryId).toBe("");
    expect(recovered.summary).toContain("Run the tests");
  });

  test("a recovery pass on a longer running turn within the tail budget keeps its newest steps, at most half of it", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "keel-running-"));
    process.env.KEEL_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
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
    expect(compaction.details).toMatchObject({ compactor: "keel", reason: "overflow" });
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
