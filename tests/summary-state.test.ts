import { describe, it, expect } from "bun:test";
import { freshState, previousOf } from "../src/core/summary-state";
import { sectionOf } from "../src/core/legacy-summary";
import { compile as compileAt, compileSummary } from "../src/core/summarize";
import { DEFAULT_SUMMARY_LIMITS } from "../src/core/window";
import type { NormalizedBlock } from "../src/types";

const compile = (input: Omit<Parameters<typeof compileAt>[0], "limits">) => compileAt({ limits: DEFAULT_SUMMARY_LIMITS, ...input });

describe("freshState", () => {
  it("returns all-empty for no blocks", () => {
    const r = freshState({ blocks: [], earlySlots: 3 });
    expect(r.earlyRequests).toEqual([]);
    expect(r.userMessages).toEqual([]);
    expect(r.brief).toBe("");
    expect(r.tracked).toEqual([]);
  });

  it("tracked commands stay empty by default, even with real tracked-looking commands present", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "ssh prod-server 'docker ps'" } },
    ];
    const r = freshState({ blocks, earlySlots: 3 });
    expect(r.tracked).toEqual([]);
  });

  it("records tracked commands only when trackCommands is explicitly non-empty", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "ssh prod-server" } },
    ];
    const r = freshState({ blocks, trackCommands: ["ssh"], earlySlots: 3 });
    expect(r.tracked).toEqual([{ name: "ssh", entries: ["ssh prod-server"] }]);
  });

  it("populates sections from realistic blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix the auth bug" },
      { kind: "tool_call", name: "Read", args: { file_path: "auth.ts" } },
      { kind: "tool_result", name: "Read", text: "const x = 1;" },
      { kind: "tool_call", name: "Edit", args: { file_path: "auth.ts" } },
      { kind: "tool_result", name: "Edit", text: "ok" },
      { kind: "assistant", text: "- run tests next" },
    ];
    const r = freshState({ blocks, earlySlots: 3 });
    expect(r.earlyRequests).toContain("Fix the auth bug");
    expect(r.brief).toContain('[user]');
    expect(r.brief).toContain('* Read "auth.ts"');
    expect(r.brief).toContain('* Edit "auth.ts"');
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

  it("brief transcript hides tool results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "Read", text: "lots of code here ..." },
      { kind: "tool_result", name: "bash", text: "Command not found" },
    ];
    const r = freshState({ blocks, earlySlots: 3 });
    expect(r.brief).toBe("");
  });

  it("brief transcript merges adjacent assistant sections", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Part one." },
      { kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
      { kind: "assistant", text: "Part two." },
    ];
    const r = freshState({ blocks, earlySlots: 3 });
    const matches = r.brief.match(/\[assistant\]/g);
    expect(matches?.length).toBe(1);
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
    let previous: ReturnType<typeof previousOf> | undefined;
    let last: ReturnType<typeof compileSummary> | undefined;
    for (const messages of windows) {
      last = compileSummary({ messages, previous, limits: DEFAULT_SUMMARY_LIMITS });
      previous = previousOf(last.state);
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

  it("a tracked command whose name has a colon keeps its entries", () => {
    const w = (cmd: string, id: string) => windowOf(call("bash", { command: cmd }, id));
    let previous: ReturnType<typeof previousOf> | undefined;
    let out: ReturnType<typeof compileSummary> | undefined;
    for (const [cmd, id] of [["c:tool run one", "1"], ["c:tool run two", "2"]]) {
      out = compileSummary({ messages: w(cmd, id), previous, trackCommands: ["c:tool"], limits: DEFAULT_SUMMARY_LIMITS });
      previous = previousOf(out.state);
    }
    expect(out!.state.tracked).toEqual([{ name: "c:tool", entries: ["c:tool run one", "c:tool run two"] }]);
  });
});
