// Pi's context edits as the compaction applies them (lisp/src/context-edits.lisp,
// op context-edits), checked against Pi's own projection where Pi is installed.
import { describe, expect, test } from "bun:test";
import { core } from "../src/core/lisp-core";

const applyContextEdits = (branch: any[]): any[] => core({ op: "context-edits", branch }).entries as any[];
import { assertRealPi, piInstalled } from "./support/pi";

const msg = (id: string, message: any) => ({ type: "message", id, parentId: null, timestamp: "2026-11-06T00:00:00.000Z", message });
const edit = (id: string, targetId: string, replacement: any) => ({ type: "context_edit", id, parentId: null, timestamp: "2026-11-06T00:00:00.000Z", targetId, replacement });

const branch = () => [
  msg("u1", { role: "user", content: "Try the migration", timestamp: 1 }),
  msg("a1", { role: "assistant", content: [{ type: "text", text: "First attempt" }], timestamp: 2 }),
  msg("a2", { role: "assistant", content: [{ type: "toolCall", id: "k", name: "bash", arguments: { command: "cat .env" } }], timestamp: 3 }),
  msg("t1", { role: "toolResult", toolCallId: "k", toolName: "bash", content: [{ type: "text", text: "API_KEY=secret" }], isError: false, timestamp: 4 }),
  { type: "custom_message", id: "c1", parentId: null, timestamp: "2026-11-06T00:00:00.000Z", customType: "note", content: "draft", display: true },
  msg("x1", { role: "bashExecution", command: "ls", output: "a b", exitCode: 0, timestamp: 5 }),
];

describe("the branch as Pi's context holds it", () => {
  test("a branch without edits (every omp branch) comes back as it is", () => {
    const b = branch();
    expect(applyContextEdits(b)).toEqual(b);
  });

  test("an omission drops the target, a replacement swaps only its content, and the edits themselves go", () => {
    const b = [
      ...branch(),
      edit("e1", "a1", null),
      edit("e2", "t1", { content: "[redacted]" }),
      edit("e3", "c1", { content: "final" }),
    ];
    const out = applyContextEdits(b) as any[];
    expect(out.map((e) => e.id)).toEqual(["u1", "a2", "t1", "c1", "x1"]);
    const t1 = out.find((e) => e.id === "t1");
    // A string replacement becomes a text block where Pi's toolResult wants blocks; role and metadata stay.
    expect(t1.message).toMatchObject({ role: "toolResult", toolCallId: "k", toolName: "bash", content: [{ type: "text", text: "[redacted]" }] });
    expect(out.find((e) => e.id === "c1").content).toBe("final");
    // The raw entries are not changed.
    expect((b[3] as any).message.content[0].text).toBe("API_KEY=secret");
  });

  test("an edit aimed at no entry changes nothing, and is itself left out", () => {
    const out = applyContextEdits([...branch(), edit("e1", "nope", null)]) as any[];
    expect(out.map((e) => e.id)).toEqual(["u1", "a1", "a2", "t1", "c1", "x1"]);
  });

  test("the latest edit of a target wins, and a role Pi does not edit keeps its content", () => {
    const b = [
      ...branch(),
      edit("e1", "a1", { content: "edited once" }),
      edit("e2", "a1", { content: [{ type: "text", text: "edited twice" }] }),
      edit("e3", "x1", { content: "not for bashExecution" }),
    ];
    const out = applyContextEdits(b) as any[];
    expect(out.find((e) => e.id === "a1").message.content).toEqual([{ type: "text", text: "edited twice" }]);
    expect(out.find((e) => e.id === "x1").message.output).toBe("a b");
    expect(out.find((e) => e.id === "x1").message.content).toBeUndefined();
  });

  test.skipIf(!piInstalled())("matches Pi's own buildSessionProjection on the messages it yields", async () => {
    assertRealPi();
    const pi: any = await import("@earendil-works/pi-coding-agent");
    let parent: string | null = null;
    const linked = [
      ...branch(),
      edit("e1", "a1", null),
      edit("e2", "t1", { content: "[redacted]" }),
      edit("e3", "c1", { content: "final" }),
    ].map((e) => {
      const withParent = { ...e, parentId: parent };
      parent = e.id;
      return withParent;
    });
    const piMessages = pi.buildSessionContext(linked, parent).messages;
    const ours = applyContextEdits(linked).flatMap((e: any) => pi.sessionEntryToContextMessages(e));
    expect(ours).toEqual(piMessages);
  });
});
