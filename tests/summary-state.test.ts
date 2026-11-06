import { describe, it, expect } from "bun:test";
import { freshState, readState, type SummaryState } from "../src/core/summary-state";
import { sectionOf } from "../src/core/legacy-summary";
import { compile as compileAt, compileSummary } from "../src/core/summarize";
import { DEFAULT_SUMMARY_LIMITS } from "../src/core/window";
import type { NormalizedBlock } from "../src/types";

const compile = (input: Omit<Parameters<typeof compileAt>[0], "limits">) => compileAt({ limits: DEFAULT_SUMMARY_LIMITS, ...input });

describe("readState", () => {
  const stored = { earlyRequests: ["goal"], files: { modified: ["a.ts"], created: [], read: [] }, commits: [{ hash: "abc1234", message: "m" }], userMessages: [], brief: "[user]\ngoal" };

  it("loads a state stored before a section existed, with that section empty", () => {
    // No `tracked`: as a release before it would have stored it.
    expect(readState(stored)).toEqual({ ...stored, tracked: [], earlySlots: 2 });
  });

  it("is no state when a section has another shape (a hand-edited file)", () => {
    expect(readState({ ...stored, tracked: "ssh" })).toBeUndefined();
    expect(readState({ ...stored, files: { ...stored.files, read: [1] } })).toBeUndefined();
    expect(readState("text")).toBeUndefined();
  });
});

describe("freshState", () => {
  it("returns all-empty for no blocks", () => {
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

  it("ends with … and the #N that vcc_recall expands", () => {
    const { earlyRequests } = freshState({ blocks: [{ kind: "user", text: long, sourceIndex: 0 }], earlySlots: 3 });
    expect(earlyRequests).toHaveLength(1);
    expect(earlyRequests[0]).toEndWith("with the message… (#0)");
    expect(earlyRequests[0].length).toBeLessThan(long.length);
  });

  it("keeps its ref through the summary pipeline (filterNoise rebuilt user blocks without it)", () => {
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
    expect(sectionOf(out.text, "Files And Changes").match(/module\.ts/g)).toHaveLength(1);
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
