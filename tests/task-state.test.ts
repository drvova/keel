// [Task State] (src/core/task-state.ts): where the work stands, read off the
// transcript by rule, shown only when the request is summarized away.
import { describe, expect, it } from "bun:test";
import { buildTaskState } from "../src/core/task-state";

const user = (text: string, extra: Record<string, unknown> = {}) => ({ role: "user", content: text, ...extra });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, text: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text }], isError });
const state = (messages: unknown[]) => buildTaskState({ messages, indices: messages.map((_, i) => i) });

describe("[Task State]", () => {
  it("says what the latest request is, what changed since, and the failure nothing fixed", () => {
    expect(state([
      user("first, unrelated request"),
      user("fix the rounding in src/money.ts please"),
      call("a", "edit", { path: "src/money.ts", edits: [{ oldText: "a", newText: "b" }] }), result("a", "ok"),
      call("b", "bash", { command: "bun test" }), result("b", "money.test.ts:\n1 fail\nexpected 0.3", true),
    ])).toEqual([
      "Request (#1): fix the rounding in src/money.ts please",
      "Since then: 2 tool calls, 1 failed; changed src/money.ts.",
      'Unresolved failure (#5): bash "bun test": expected 0.3',
    ]);
  });

  it("names the last result when the failure was fixed by a later run of the same call", () => {
    expect(state([
      user("run the tests and fix them"),
      call("a", "bash", { command: "bun test" }), result("a", "1 fail", true),
      call("b", "bash", { command: "bun test" }), result("b", "all pass"),
    ])).toEqual([
      "Request (#0): run the tests and fix them",
      "Since then: 2 tool calls, 1 failed; no file changed.",
      'Last result (#4): bash "bun test" succeeded.',
    ]);
  });

  it("is empty only with no request since /clear", () => {
    expect(state([user("fix the rounding please"), call("a", "bash", { command: "ls" }), result("a", "x")]))
      .toEqual(["Request (#0): fix the rounding please", "Since then: 1 tool call; no file changed.", 'Last result (#2): bash "ls" succeeded.']);
    expect(state([call("a", "bash", { command: "ls" }), result("a", "x")])).toEqual([]);
  });

  it("reads past what the user did not write: an extension's message, a host block, a one-word reply", () => {
    expect(state([
      user("refactor the billing retries"),
      user("ok"),
      user("<system-reminder>be brief</system-reminder>"),
      user("an extension asked this", { attribution: "agent" }),
    ])).toEqual(["Request (#0): refactor the billing retries", "Since then: no tool calls yet."]);
  });
});
