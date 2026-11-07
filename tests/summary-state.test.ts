// The summary's stored state (lisp/src/summary.lisp): what one compaction's
// window adds, and how the next compaction merges into what this one stored.
import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compileSummary, type SummaryState } from "./support/compile";
import { DEFAULT_SUMMARY_LIMITS } from "./support/window";
import { COMPACT_INSTRUCTION } from "./support/names";
import type { NormalizedBlock } from "./support/compile";
import { registerHook } from "./support/host";
import { sectionLines, summarize } from "./support/summary";

const compile = (input: Omit<Parameters<typeof compileSummary>[0], "limits">) => compileSummary({ limits: DEFAULT_SUMMARY_LIMITS, ...input }).text;
/** What a window of these blocks adds to the state, with EARLY of the session's first requests still to take. */
const freshState = ({ blocks, trackCommands, earlySlots }: { blocks: NormalizedBlock[]; trackCommands?: string[]; earlySlots: number }): SummaryState =>
  summarize(blocks, {
    trackCommands,
    // A state that has taken all but EARLY of them, and nothing else.
    ...(earlySlots < 3 ? { previous: { earlyRequests: [], files: { modified: [], created: [], read: [] }, commits: [], tracked: [], userMessages: [], brief: "", earlySlots } } : {}),
  }).state;

describe("a stored state read back", () => {
  let dir: string;
  const prev = process.env.KEEL_CONFIG_PATH;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "keel-state-"));
    process.env.KEEL_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false }));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.KEEL_CONFIG_PATH;
    else process.env.KEEL_CONFIG_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  const stored = { earlyRequests: ["goal"], files: { modified: ["a.ts"], created: [], read: [] }, commits: [{ hash: "abc1234", message: "m" }], userMessages: [], brief: "[user]\ngoal" };
  /** The state the next compaction stores, after one that stored SUMMARYSTATE. */
  const next = (summaryState: unknown): SummaryState => {
    const say = (id: string, role: string, text: string) => ({ id, type: "message", message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] } });
    const branchEntries = [say("a", "user", "goal"), say("b", "assistant", "ok"),
      { id: "k", type: "compaction", firstKeptEntryId: "", summary: "[user]\ngoal", details: { compactor: "keel", version: 2, summaryState } },
      say("c", "user", "next request"), say("d", "assistant", "on it"), say("e", "assistant", "the work went as planned. ".repeat(100))];
    let handler: any;
    registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    return handler({
      type: "session_before_compact", branchEntries, customInstructions: `${COMPACT_INSTRUCTION} keep:0`,
      preparation: { previousSummary: "[user]\ngoal", fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} }, sessionManager: { getEntries: () => branchEntries } }).compaction.details.summaryState;
  };

  it("loads a state stored before a section existed, with that section empty", () => {
    // No `tracked`: as a release before it would have stored it.
    const r = next(stored);
    expect(r.files.modified).toEqual(["a.ts"]);
    expect(r.commits).toEqual([{ hash: "abc1234", message: "m" }]);
    expect(r.tracked).toEqual([]);
  });

  it("is no state when a section has another shape (a hand-edited file)", () => {
    for (const bad of [{ ...stored, tracked: "ssh" }, { ...stored, files: { ...stored.files, read: [1] } }, "text"]) {
      expect(next(bad).files.modified).toEqual([]);
    }
  });
});

describe("what a window adds", () => {
  it("is nothing for no blocks", () => {
    const r = freshState({ blocks: [], earlySlots: 3 });
    expect(r.earlyRequests).toEqual([]);
    expect(r.userMessages).toEqual([]);
    expect(r.brief).toBe("");
    expect(r.tracked).toEqual([]);
  });

  it("records each tracked command's invocations under its name", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "ssh prod-server" } },
    ];
    const r = freshState({ blocks, trackCommands: ["ssh"], earlySlots: 3 });
    expect(r.tracked).toEqual([{ name: "ssh", entries: ["ssh prod-server"] }]);
  });

  it("takes early requests and user messages by position, not by wording", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "改成用 JWT 而不是 session cookie" },
      { kind: "user", text: "second request here" },
      { kind: "user", text: "third request here" },
      { kind: "user", text: "ok" },
      { kind: "user", text: '<skill name="tdd" location="x">steps</skill>' },
      { kind: "user", text: '<skill name="tdd" location="x">steps</skill>\n\nwrite the\n  failing test first' },
      { kind: "user", text: "relayed note", injected: true },
      { kind: "user", text: '<peer_message from="x">relayed by a tool</peer_message>' },
    ];
    const r = freshState({ blocks, earlySlots: 3 });
    expect(r.earlyRequests).toEqual(["改成用 JWT 而不是 session cookie", "second request here", "third request here"]);
    expect(r.userMessages).toEqual(["[skill: tdd] write the failing test first"]);
    // Early requests already pinned by the previous summary: the first messages are ordinary.
    expect(freshState({ blocks, earlySlots: 0 }).userMessages[0]).toBe("改成用 JWT 而不是 session cookie");
  });
});

// Seen with a real model: the first request, cut at 300 characters, lost the
// commit message it asked for and read as complete.
describe("a clipped user message", () => {
  const long = "Set up a tiny Python project in this directory. Write src/money.py with a function round_cents(x) that rounds a Decimal to 2 places using ROUND_HALF_EVEN, and tests/test_money.py with three plain assert checks you run with python3 (no pytest). Run the tests, then commit everything with the message 'feat: round_cents'. Keep it short.";

  it("ends with … and the #N that keel_recall expands", () => {
    const { earlyRequests } = freshState({ blocks: [{ kind: "user", text: long, sourceIndex: 0 }], earlySlots: 3 });
    expect(earlyRequests).toHaveLength(1);
    expect(earlyRequests[0]).toEndWith("with the message… (#0)");
    expect(earlyRequests[0].length).toBeLessThan(long.length);
  });

  it("keeps its ref through the summary pipeline", () => {
    const r = compile({ messages: [{ role: "user", content: long }, { role: "assistant", content: [{ type: "text", text: "ok" }] }] as any, sourceIndices: [0, 1] });
    expect(r).toContain("with the message… (#0)");
  });

  it("without a ref ends with … alone, and a message that fits is unchanged", () => {
    expect(freshState({ blocks: [{ kind: "user", text: long }], earlySlots: 3 }).earlyRequests[0]).toEndWith("with the message…");
    expect(freshState({ blocks: [{ kind: "user", text: "fix the auth bug", sourceIndex: 3 }], earlySlots: 3 }).earlyRequests).toEqual(["fix the auth bug"]);
  });
});

describe("carried sections merge from the stored state", () => {
  const call = (name: string, args: Record<string, unknown>, id: string) =>
    [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false }];
  const windowOf = (...msgs: any[][]) => [{ role: "user", content: "work on the files" }, ...msgs.flat()] as any[];
  /** Three compactions in a row, each merging into the state the one before stored. */
  const chain = (...windows: any[][]) => {
    let previous: SummaryState | undefined;
    let last: ReturnType<typeof compileSummary> | undefined;
    for (const messages of windows) {
      last = compileSummary({ messages, previous, limits: DEFAULT_SUMMARY_LIMITS });
      previous = last.state;
    }
    return last!;
  };
  const filesLine = (text: string, label: string) =>
    text.replace(/\n[ \t]+(?=\S)/g, " ").split("\n").find((l) => l.startsWith(`- ${label}: `)) ?? "";

  it("a path with a comma, or one long enough to wrap, is one file however many compactions it goes through", () => {
    const comma = "docs/notes, draft.md";
    const long = `src/${"deeply/nested/".repeat(9)}module.ts`;
    const w = (id: string) => windowOf(call("edit", { path: comma, old_string: "a", new_string: "b" }, `${id}a`), call("edit", { path: long, old_string: "a", new_string: "b" }, `${id}b`));
    const out = chain(w("1"), w("2"), w("3"));
    expect(out.state.files.modified).toEqual([comma, long]);
    expect(filesLine(out.text, "Modified")).toStartWith(`- Modified: ${comma}, src/`);
    expect(sectionLines(out.text, "Files And Changes").join("\n").match(/module\.ts/g)).toHaveLength(1);
  });

  it("the same absolute file in windows that share different directories is one file", () => {
    const a = windowOf(call("read", { path: "/work/app/src/a.ts" }, "1"), call("read", { path: "/work/app/src/b.ts" }, "2"));
    const b = windowOf(call("read", { path: "/work/app/src/a.ts" }, "3"), call("read", { path: "/work/app/lib/c.ts" }, "4"));
    const out = chain(a, b);
    expect(out.state.files.read).toEqual(["/work/app/src/b.ts", "/work/app/src/a.ts", "/work/app/lib/c.ts"]);
    // Listed relative to what the listed paths share.
    expect(filesLine(out.text, "Read")).toBe("- Read: src/b.ts, src/a.ts, lib/c.ts");
  });

  it("a file read in one window and written whole in a later one existed: Modified, as in one window", () => {
    const r = chain(windowOf(call("read", { path: "/r/src/config.ts" }, "1")), windowOf(call("write", { path: "/r/src/config.ts", content: "x = 1" }, "2")));
    expect(r.state.files.modified).toContain("/r/src/config.ts");
    expect(r.state.files.created).not.toContain("/r/src/config.ts");
  });

  it("writing a file another window read and edited leaves the files created around it as they were", () => {
    const edited = windowOf(call("read", { path: "/r/src/x.ts" }, "2"), call("edit", { path: "/r/src/x.ts", old_string: "a", new_string: "b" }, "3"));
    const r = chain(windowOf(call("write", { path: "/r/src/a.ts", content: "new" }, "1")), edited, windowOf(call("write", { path: "/r/src/x.ts", content: "x = 1" }, "4")));
    expect(r.state.files).toMatchObject({ created: ["/r/src/a.ts"], modified: ["/r/src/x.ts"] });
    const beside = chain(edited, windowOf(call("write", { path: "/r/src/new.ts", content: "y" }, "5"), call("write", { path: "/r/src/x.ts", content: "x = 1" }, "6")));
    expect(beside.state.files.created).toEqual(["/r/src/new.ts"]);
  });

  it("a read that failed is no sign the file existed, in one window or across a compaction", () => {
    const failedRead = (path: string, id: string) =>
      [{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] }, { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "ENOENT: no such file or directory" }], isError: true }];
    const one = chain(windowOf(failedRead("/r/src/new.ts", "1"), call("write", { path: "/r/src/new.ts", content: "y" }, "2")));
    const two = chain(windowOf(failedRead("/r/src/new.ts", "1")), windowOf(call("write", { path: "/r/src/new.ts", content: "y" }, "2")));
    expect(one.state.files.created).toEqual(["/r/src/new.ts"]);
    expect(two.state.files.created).toEqual(["/r/src/new.ts"]);
  });

  it("after another compactor's summary, no later compaction takes a request for an early one", () => {
    const llm = "## Goal\nThe user is building a payments service.";
    const first = compileSummary({ messages: [{ role: "user", content: "now wire the refunds endpoint" }] as any, previousSummary: llm, previousSummaryForeign: true, limits: DEFAULT_SUMMARY_LIMITS });
    const second = compileSummary({ messages: [{ role: "user", content: "now add the export command to the CLI" }] as any, previous: first.state, limits: DEFAULT_SUMMARY_LIMITS });
    expect(second.state.earlyRequests).toEqual([]);
    expect(second.text).not.toContain("[Early Session Requests]");
  });

  it("a tracked command whose name has a colon keeps its entries", () => {
    const w = (cmd: string, id: string) => windowOf(call("bash", { command: cmd }, id));
    let previous: SummaryState | undefined;
    let out: ReturnType<typeof compileSummary> | undefined;
    for (const [cmd, id] of [["c:tool run one", "1"], ["c:tool run two", "2"]]) {
      out = compileSummary({ messages: w(cmd, id), previous, trackCommands: ["c:tool"], limits: DEFAULT_SUMMARY_LIMITS });
      previous = out.state;
    }
    expect(out!.state.tracked).toEqual([{ name: "c:tool", entries: ["c:tool run one", "c:tool run two"] }]);
  });
});
