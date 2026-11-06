import { describe, it, expect } from "bun:test";
import { renderMessage } from "../src/core/render-entries";
import type { Message } from "@oh-my-pi/pi-ai";
import { userMsg, assistantText, assistantWithToolCall, toolResult } from "./fixtures";

describe("renderMessage", () => {
  it("renders user message", () => {
    const r = renderMessage(userMsg("hello"), 0);
    expect(r).toEqual({ index: 0, role: "user", summary: "hello" });
  });

  it("renders assistant text", () => {
    const r = renderMessage(assistantText("done"), 1);
    expect(r.role).toBe("assistant");
    expect(r.summary).toBe("done");
  });

  it("renders tool result as [tool] and its text", () => {
    const r = renderMessage(toolResult("bash", "not found"), 3);
    expect(r.role).toBe("tool_result");
    expect(r.summary).toBe("[bash] not found");
  });

  it("renders tool call arguments with values", () => {
    const r = renderMessage(assistantWithToolCall("Read", { path: "a.ts" }), 2);
    expect(r.summary).toContain("Read(path=a.ts)");
  });

  it("names the files of a multi-path edit tool call", () => {
    const r = renderMessage(assistantWithToolCall("edit", { code: "...", paths: ["a.ts", "b.ts", "c.ts"] }), 2);
    expect(r.summary).toContain("edit(path=a.ts +2)");
    expect(r.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("truncates long user text", () => {
    const long = "x".repeat(500);
    const r = renderMessage(userMsg(long), 0);
    expect(r.summary.length).toBeLessThanOrEqual(300);
  });

  it("renders bashExecution message", () => {
    const msg = { role: "bashExecution", command: "ls -la", output: "total 0\n" } as any;
    const r = renderMessage(msg, 5);
    expect(r.role).toBe("bash");
    expect(r.summary).toContain("$ ls -la");
    expect(r.summary).toContain("total 0");
  });

  it("renders bashExecution with missing output", () => {
    const msg = { role: "bashExecution", command: "exit 1" } as any;
    const r = renderMessage(msg, 6);
    expect(r.role).toBe("bash");
    expect(r.summary).toBe("$ exit 1\n");
  });

  it("handles message with undefined content", () => {
    const msg = { role: "assistant", content: undefined } as any;
    const r = renderMessage(msg, 3);
    expect(r.role).toBe("assistant");
    expect(r.summary).toBe("");
  });
});


// From a sibling omp port's audit: search reads tool arguments, so a hit inside
// a write's content came back as a ref whose expand showed only write(path=…).
describe("renderMessage full view shows tool-call arguments", () => {
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

  it("prints the arguments the one-line summary leaves out, only in the full view", () => {
    const msg: any = { role: "assistant", content: [call("t1", "write", { path: "conf.yml", content: "retries: 7\nzebrafish_mode: on\n", i: "Writing config" })] };
    expect(renderMessage(msg, 1, true).summary).toBe("write(path=conf.yml)\n  content: retries: 7\n    zebrafish_mode: on");
    expect(renderMessage(msg, 1, false).summary).toBe("write(path=conf.yml)");
  });

  it("labels each call's arguments when one message makes several, and clips long ones", () => {
    const msg: any = { role: "assistant", content: [call("t1", "write", { path: "a.txt", content: "x" }), call("t2", "bash", { command: "ls", timeout: 30, env: "A=1\nB=2" })] };
    expect(renderMessage(msg, 4, true).summary).toBe("write(path=a.txt), bash(command=ls)\n  write:\n    content: x\n  bash:\n    timeout: 30\n    env: A=1\n      B=2");
    const long: any = { role: "assistant", content: [call("t3", "write", { path: "b.txt", content: "y".repeat(9000) })] };
    expect(renderMessage(long, 7, true).summary).toContain("...[arguments of #7 clipped at 4000 of");
  });

  it("points a clipped write at its file content, in the session it was read from", () => {
    const long: any = { role: "assistant", content: [call("t3", "write", { path: "b.txt", content: "y".repeat(200) })] };
    expect(renderMessage(long, 7, true, { chars: 50, via: " with session:'aaaa1111'" }).summary)
      .toContain("query '#7:b.txt:full' with session:'aaaa1111' reads the file content]");
  });
});
