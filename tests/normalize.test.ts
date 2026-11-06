import { describe, it, expect } from "bun:test";
import { normalize } from "../src/core/normalize";
import {
  userMsg,
  assistantText,
  assistantWithThinking,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

describe("normalize", () => {
  it("returns empty for empty input", () => {
    expect(normalize([])).toEqual([]);
  });

  it("normalizes user message (string content)", () => {
    const blocks = normalize([userMsg("fix the bug")]);
    expect(blocks).toEqual([{ kind: "user", text: "fix the bug", sourceIndex: 0 }]);
  });

  it("carries the injected flag onto user blocks", () => {
    const injected = { ...userMsg("relayed note"), injected: true } as any;
    expect(normalize([injected])).toEqual([{ kind: "user", text: "relayed note", sourceIndex: 0, injected: true }]);
  });

  it("normalizes assistant text message", () => {
    const blocks = normalize([assistantText("done")]);
    expect(blocks).toEqual([{ kind: "assistant", text: "done", sourceIndex: 0 }]);
  });

  it("normalizes assistant string content", () => {
    const msg = { ...assistantText("done"), content: "plain text" } as any;
    expect(normalize([msg])).toEqual([{ kind: "assistant", text: "plain text", sourceIndex: 0 }]);
  });

  it("skips assistant thinking blocks", () => {
    const blocks = normalize([assistantWithThinking("result", "hmm")]);
    expect(blocks).toEqual([{ kind: "assistant", text: "result", sourceIndex: 0 }]);
  });

  it("normalizes tool call", () => {
    const blocks = normalize([assistantWithToolCall("Read", { path: "a.ts" })]);
    expect(blocks).toEqual([{
      kind: "tool_call", id: "tc_1", name: "Read", args: { path: "a.ts" }, sourceIndex: 0,
    }]);
  });

  it("normalizes tool result", () => {
    const blocks = normalize([toolResult("Read", "file contents")]);
    expect(blocks).toEqual([{
      kind: "tool_result", callId: "tc_1", name: "Read",
      text: "file contents", sourceIndex: 0,
    }]);
  });

  it("handles mixed message sequence", () => {
    const blocks = normalize([
      userMsg("fix it"),
      assistantWithToolCall("Read", { path: "x.ts" }),
      toolResult("Read", "code"),
      assistantText("done"),
    ]);
    expect(blocks).toHaveLength(4);
    expect(blocks.map((b) => b.kind)).toEqual([
      "user", "tool_call", "tool_result", "assistant",
    ]);
  });

  it("produces image placeholder for user image content", () => {
    const msg = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "look at this" },
        { type: "image" as const, data: "abc", mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    };
    const blocks = normalize([msg]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "user", text: "look at this", sourceIndex: 0 });
    expect(blocks[1]).toEqual({ kind: "user", text: "[image: image/png]", sourceIndex: 0 });
  });

  it("normalizes bashExecution messages", () => {
    const msg = { role: "bashExecution", command: "ls -la", output: "files", exitCode: 0 } as any;
    const blocks = normalize([msg]);
    expect(blocks).toEqual([
      { kind: "bash", command: "ls -la", output: "files", exitCode: 0, sourceIndex: 0 },
    ]);
  });

  it("skips truly unknown message roles gracefully", () => {
    const custom = { role: "custom", content: "hello" } as any;
    expect(normalize([custom])).toEqual([]);
  });
});



describe("normalize with malformed entries", () => {
  it("skips what it cannot read instead of throwing out of the compaction", () => {
    const blocks = normalize([
      { role: "user", content: [{ type: "text", text: "fix it" }, null, { type: "text" }] },
      { role: "assistant", content: [null, { type: "toolCall", id: "t", name: null, arguments: null }, { type: "text", text: "ok" }] },
      { role: "assistant", content: 42 },
      null,
    ] as any);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "tool_call", "assistant"]);
    expect(blocks[1]).toMatchObject({ name: "unknown", args: {} });
  });
});
