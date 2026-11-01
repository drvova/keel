import { describe, it, expect } from "bun:test";
import { buildSections } from "../src/core/build-sections";
import { compile } from "../src/core/summarize";
import type { NormalizedBlock } from "../src/types";

describe("buildSections", () => {
  it("returns all-empty for no blocks", () => {
    const r = buildSections({ blocks: [] });
    expect(r.earlyRequests).toEqual([]);
    expect(r.userMessages).toEqual([]);
    expect(r.briefTranscript).toBe("");
    expect(r.trackedCommands).toEqual([]);
  });

  it("trackedCommands stays empty by default, even with real tracked-looking commands present", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "ssh prod-server 'docker ps'" } },
    ];
    const r = buildSections({ blocks });
    expect(r.trackedCommands).toEqual([]);
  });

  it("populates trackedCommands only when trackCommands is explicitly non-empty", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "ssh prod-server" } },
    ];
    const r = buildSections({ blocks, trackCommands: ["ssh"] });
    expect(r.trackedCommands).toEqual(["ssh: ssh prod-server"]);
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
    const r = buildSections({ blocks });
    expect(r.earlyRequests).toContain("Fix the auth bug");
    expect(r.briefTranscript).toContain('[user]');
    expect(r.briefTranscript).toContain('* Read "auth.ts"');
    expect(r.briefTranscript).toContain('* Edit "auth.ts"');
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
    const r = buildSections({ blocks });
    expect(r.earlyRequests).toEqual(["改成用 JWT 而不是 session cookie", "second request here", "third request here"]);
    expect(r.userMessages).toEqual(["[skill: tdd] write the failing test first"]);
    // Early requests already pinned by the previous summary: the first messages are ordinary.
    expect(buildSections({ blocks, hasEarlyRequests: true }).userMessages[0]).toBe("改成用 JWT 而不是 session cookie");
  });

  it("brief transcript hides tool results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "Read", text: "lots of code here ..." },
      { kind: "tool_result", name: "bash", text: "Command not found" },
    ];
    const r = buildSections({ blocks });
    expect(r.briefTranscript).toBe("");
  });

  it("brief transcript merges adjacent assistant sections", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Part one." },
      { kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
      { kind: "assistant", text: "Part two." },
    ];
    const r = buildSections({ blocks });
    const matches = r.briefTranscript.match(/\[assistant\]/g);
    expect(matches?.length).toBe(1);
  });
});

// Seen with a real model: the first request, cut at 300 characters, lost the
// commit message it asked for and read as complete.
describe("a clipped user message", () => {
  const long = "Set up a tiny Python project in this directory. Write src/money.py with a function round_cents(x) that rounds a Decimal to 2 places using ROUND_HALF_EVEN, and tests/test_money.py with three plain assert checks you run with python3 (no pytest). Run the tests, then commit everything with the message 'feat: round_cents'. Keep it short.";

  it("ends with … and the #N that vcc_recall expands", () => {
    const { earlyRequests } = buildSections({ blocks: [{ kind: "user", text: long, sourceIndex: 0 }] });
    expect(earlyRequests).toHaveLength(1);
    expect(earlyRequests[0]).toEndWith("with the message… (#0)");
    expect(earlyRequests[0].length).toBeLessThan(long.length);
  });

  it("keeps its ref through the summary pipeline (filterNoise rebuilt user blocks without it)", () => {
    const r = compile({ messages: [{ role: "user", content: long }, { role: "assistant", content: [{ type: "text", text: "ok" }] }] as any, sourceIndices: [0, 1] });
    expect(r).toContain("with the message… (#0)");
  });

  it("without a ref ends with … alone, and a message that fits is unchanged", () => {
    expect(buildSections({ blocks: [{ kind: "user", text: long }] }).earlyRequests[0]).toEndWith("with the message…");
    expect(buildSections({ blocks: [{ kind: "user", text: "fix the auth bug", sourceIndex: 3 }] }).earlyRequests).toEqual(["fix the auth bug"]);
  });
});
