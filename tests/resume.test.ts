// Where the last session stopped, told to the next (lisp/src/resume.lisp):
// Hy-Memory 2.0 (Tencent Hunyuan) keeps a working memory of the task and a
// coding memory of failures and what fixed them, written by a model; here both
// are read back from the last session's own transcript, with no model.
import { describe, expect, it } from "bun:test";
import { join } from "path";
import { utimesSync } from "fs";
import { fakeHost } from "./support/binding";
import { freshDir, writeJsonl } from "./support/session-files";

const text = (t: string) => [{ type: "text", text: t }];
const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, name: string, out: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: text(out) });
const entriesOf = (messages: any[]) => messages.map((message, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, message }));

/** A project with one earlier session holding MESSAGES, and a new one starting: what keel sends the agent. */
const start = async (messages: any[], current: any[] = []) => {
  const dir = freshDir();
  const old = join(dir, "2026-01-01_aaaa1111.jsonl");
  writeJsonl(old, [{ type: "session", id: "aaaa1111-0000", cwd: "/x" }, ...entriesOf(messages)]);
  utimesSync(old, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const file = join(dir, "2026-01-02_bbbb2222.jsonl");
  writeJsonl(file, [{ type: "session", id: "bbbb2222-0000", cwd: "/x" }, ...current]);
  const h = fakeHost();
  const sm = { getBranch: () => current, getEntries: () => current, getSessionFile: () => file, getSessionDir: () => dir };
  h.fire("session_start", {}, { sessionManager: sm, ui: { notify: () => {} } });
  await new Promise((r) => setTimeout(r, 0));
  return h.sent;
};

const work = [
  { role: "user", content: "fix the login bug in src/auth.ts" },
  call("t1", "bash", { command: "bun test tests/auth" }), result("t1", "bash", "1 fail\nlogin returns undefined", true),
  call("e1", "edit", { path: "src/auth.ts", oldText: "broken", newText: "fixed" }), result("e1", "edit", "Edited src/auth.ts"),
  call("t2", "bash", { command: "bun test tests/auth" }), result("t2", "bash", "1 pass"),
  call("e2", "edit", { path: "CHANGELOG.md", oldText: "a", newText: "b" }), result("e2", "edit", "no match for a", true),
];

describe("a new session starts knowing where the last one stopped", () => {
  it("its request, what it changed, the failure it fixed and how, and what it left open", async () => {
    const sent = await start(work);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe("keel-resume");
    expect(sent[0].options).toEqual({ deliverAs: "nextTurn" });
    const said = sent[0].message.content as string;
    expect(said).toStartWith("Where the last session (aaaa1111) stopped, read from its transcript:\n");
    expect(said).toContain("Request (#0): fix the login bug in src/auth.ts");
    expect(said).toContain("changed src/auth.ts, CHANGELOG.md");
    expect(said).toContain('Fixed: bash "bun test tests/auth" failed (#2); passed (#6) after src/auth.ts changed.');
    expect(said).toContain("Unresolved failure (#8): edit");
    // What a tool printed stays with its session: the fix names the run, not its output.
    expect(said.split("\n").find((l) => l.startsWith("Fixed:"))).not.toContain("undefined");
    expect(said).toEndWith('keel_recall with session:"aaaa1111" reads any #N of it.');
  });

  it("nothing for a session that has a message already (resumed, forked)", async () => {
    expect(await start(work, entriesOf([{ role: "user", content: "hi" }]))).toEqual([]);
  });

  it("nothing when the last session made no request", async () => {
    expect(await start([])).toEqual([]);
  });
});
