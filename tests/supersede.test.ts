// What a later entry superseded, said on recall's line for it (lisp/src/recall.lisp
// superseded-notes): DCPM (Hy-Memory 1.0, Tencent, arXiv:2606.09483) keeps a
// superseded fact linked to what replaced it, with an LLM to decide; here the key
// decides, with no model: the same file changed later, the same run passed later.
import { describe, expect, it } from "bun:test";
import { recallTool } from "./support/binding";
import { sessionFileOfEntries } from "./support/session-files";

const text = (t: string) => [{ type: "text", text: t }];
const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, name: string, out: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: text(out) });

// #0 the request; #1-#2 a read of auth.ts; #3-#4 a test that fails; #5-#6 an edit of auth.ts; #7-#8 the test again, passing; #9 a read of notes.md, never changed.
const messages = [
  { role: "user", content: "fix the login bug in src/auth.ts" },
  call("r1", "read", { path: "src/auth.ts" }), result("r1", "read", "export const login = () => broken;"),
  call("t1", "bash", { command: "bun test tests/auth" }), result("t1", "bash", "1 fail: login returns undefined", true),
  call("e1", "edit", { path: "src/auth.ts", oldText: "broken", newText: "fixed" }), result("e1", "edit", "Edited src/auth.ts"),
  call("t2", "bash", { command: "bun test tests/auth" }), result("t2", "bash", "1 pass"),
  call("r2", "read", { path: "notes.md" }), result("r2", "read", "deploy from main"),
  // A later request: what came before is a finished turn, which a search reads.
  { role: "user", content: "now update the changelog" },
];
const entries = messages.map((message, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, message }));

const recall = async (params: Record<string, unknown>) => {
  const { file } = sessionFileOfEntries(entries);
  const out = await recallTool().execute("call", params, undefined, undefined, {
    sessionManager: { getSessionFile: () => file, getBranch: () => entries, getEntries: () => entries },
  });
  return out.content[0].text as string;
};
/** Entry #N's line in OUT; a test fails when there is none, so a check of what it lacks cannot pass on a missing line. */
const lineOf = (out: string, n: number) => {
  const line = out.split("\n").find((l) => l.startsWith(`#${n} `));
  expect(line).toBeDefined();
  return line!;
};

describe("recall says what superseded an entry", () => {
  it("a read of a file changed later: the call and its result", async () => {
    const out = await recall({ range: [0, 10] });
    expect(lineOf(out, 1)).toContain("(superseded: src/auth.ts changed at #5)");
    expect(lineOf(out, 2)).toContain("(superseded: src/auth.ts changed at #5)");
  });

  it("a run that failed and later passed: fixed, and where", async () => {
    const out = await recall({ range: [0, 10] });
    expect(lineOf(out, 4)).toContain("(fixed: passed at #8)");
    expect(lineOf(out, 3)).toContain("(fixed: passed at #8)");
  });

  it("nothing on what still holds: the edit itself, the passing run, a file never changed", async () => {
    const out = await recall({ range: [0, 10] });
    for (const n of [5, 6, 7, 8, 9, 10]) expect(lineOf(out, n)).not.toMatch(/\((superseded|fixed):/);
  });

  it("on a search hit too", async () => {
    expect(await recall({ query: "login returns undefined" })).toContain("#4 [tool_result] (fixed: passed at #8)");
  });
});
