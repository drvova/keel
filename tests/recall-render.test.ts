// How recall shows an entry (lisp/src/render.lisp): one line per entry in a
// range or a search, the full view in expand, and what it says of nothing.
import { describe, it, expect } from "bun:test";
import { recallOn } from "./support/pairs";
import { userMsg, assistantText, assistantWithToolCall, toolResult } from "./fixtures";

/** The line a range shows of one message: the entry at #0. */
const line = (message: unknown): string => recallOn([message], { range: [0, 0] }).split("\n\n").slice(1).join("\n\n");
/** What expand shows of the entry at #N of these messages. */
const full = (messages: unknown[], n: number): string => recallOn(messages, { expand: [n] }).split("\n\n").slice(1).join("\n\n");

describe("an entry's line", () => {
  it("is its #N, its role and its text", () => {
    expect(line(userMsg("hello"))).toBe("#0 [user] hello");
    expect(line(assistantText("done"))).toBe("#0 [assistant] done");
  });

  it("shows a tool result as [tool] and its text", () => {
    expect(line(toolResult("bash", "not found"))).toBe("#0 [tool_result] [bash] not found");
  });

  it("shows a tool call's arguments with their values, and the files it works on", () => {
    expect(line(assistantWithToolCall("Read", { path: "a.ts" }))).toBe("#0 [assistant] files:[a.ts] Read(path=a.ts)");
    expect(line(assistantWithToolCall("edit", { code: "...", paths: ["a.ts", "b.ts", "c.ts"] }))).toBe("#0 [assistant] files:[a.ts, b.ts, c.ts] edit(path=a.ts +2)");
  });

  it("clips long user text", () => {
    expect(line(userMsg("x".repeat(500))).length).toBeLessThanOrEqual(320);
  });

  it("shows a command the user ran, with or without output", () => {
    expect(line({ role: "bashExecution", command: "ls -la", output: "total 0\n" })).toStartWith("#0 [bash] $ ls -la\ntotal 0");
    expect(line({ role: "bashExecution", command: "exit 1" })).toStartWith("#0 [bash] $ exit 1");
  });

  it("survives a message with no content", () => {
    expect(line({ role: "assistant", content: undefined })).toBe("#0 [assistant] ");
  });
});

describe("what recall says of nothing", () => {
  it("no entries, no matches", () => {
    expect(recallOn([], {})).toContain("No entries");
    expect(recallOn([userMsg("hello")], { query: "xyz" })).toContain('No matches for "xyz"');
  });

  it("names the query after the header and shows a hit's snippet", () => {
    // A later request: the hit is not in the turn in progress, which search leaves out.
    const out = recallOn([userMsg("hello"), assistantText(`${"filler\n".repeat(8)}the job is done`), userMsg("next")], { query: "done" });
    expect(out).toStartWith('1 matches for "done"');
    expect(out).toContain("#1 [assistant] ");
    expect(out).toContain("the job is done");
  });
});

// From a sibling omp port's audit: search reads tool arguments, so a hit inside
// a write's content came back as a ref whose expand showed only write(path=…).
describe("expand shows a tool call's arguments", () => {
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

  it("prints the arguments the one-line summary leaves out, only in the full view", () => {
    const msg = { role: "assistant", content: [call("t1", "write", { path: "conf.yml", content: "retries: 7\nzebrafish_mode: on\n", i: "Writing config" })] };
    expect(full([msg], 0)).toBe("#0 [assistant] files:[conf.yml] write(path=conf.yml)\n  content: retries: 7\n    zebrafish_mode: on");
    expect(line(msg)).toBe("#0 [assistant] files:[conf.yml] write(path=conf.yml)");
  });

  it("labels each call's arguments when one message makes several, and clips long ones", () => {
    const msg = { role: "assistant", content: [call("t1", "write", { path: "a.txt", content: "x" }), call("t2", "bash", { command: "ls", timeout: 30, env: "A=1\nB=2" })] };
    expect(full([msg], 0)).toBe("#0 [assistant] files:[a.txt] write(path=a.txt), bash(command=ls)\n  write:\n    content: x\n  bash:\n    timeout: 30\n    env: A=1\n      B=2");
    const long = { role: "assistant", content: [call("t3", "write", { path: "b.txt", content: "y".repeat(9000) })] };
    expect(full([long], 0)).toContain("...[arguments of #0 clipped at 4000 of");
  });

  it("points a clipped write at its file content, at a smaller window's clip", () => {
    const long = { role: "assistant", content: [call("t3", "write", { path: "b.txt", content: "y".repeat(2000) })] };
    // An 8K window caps recall at 8 KB, and expand's clip with it.
    expect(recallOn([long], { expand: [0] }, { contextWindow: 8_000 })).toContain("query '#0:b.txt:full' reads the file content]");
  });
});
