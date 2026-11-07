// What each message becomes in a summary: the user's words in the request
// sections, every kind of message in the brief, what a host put in and what an
// extension relayed kept apart from what the user wrote, and nothing that
// cannot be read thrown out of the compaction.
import { describe, expect, it } from "bun:test";
import { briefOf, summarize } from "./support/summary";

const of = (messages: any[]) => summarize({ messages });

describe("what each message becomes in the summary", () => {
  it("text is cleaned of terminal escapes and control characters, its line ends made \\n", () => {
    const s = of([{ role: "user", content: "fix the \x1b[31mlogin\x1b[0m bug\r\nplease, a\x00b" }]);
    expect(s.state.earlyRequests).toEqual(["fix the login bug please, ab"]);
    expect(briefOf(s.text)).toContain("fix the login bug\nplease, ab (#0)");
  });

  it("a host's <system-reminder> is not the user's: alone it leaves nothing, beside the user's words it is cut", () => {
    const s = of([
      { role: "user", content: "<system-reminder>noise</system-reminder>" },
      { role: "user", content: "<system-reminder>noise</system-reminder>\nthen fix logout" },
      // Other tags are the user's own text.
      { role: "user", content: "<ide_opened_file>a.ts</ide_opened_file> look at this" },
    ]);
    expect(s.text).not.toContain("noise");
    expect(s.state.earlyRequests).toEqual(["then fix logout"]);
    expect(briefOf(s.text)).toContain("<ide_opened_file>a.ts</ide_opened_file> look at this");
  });

  it("what an extension relayed shows in the brief, never as the user's request", () => {
    const s = of([{ role: "user", content: "the user's own request" }, { role: "user", content: "relayed by an extension", injected: true }]);
    expect(briefOf(s.text)).toContain("relayed by an extension");
    expect([...s.state.earlyRequests, ...s.state.userMessages]).toEqual(["the user's own request"]);
  });

  it("an assistant's text, string or blocks, its tool calls, and the files they read; never its thinking", () => {
    const s = of([
      { role: "assistant", content: [{ type: "thinking", thinking: "SECRET THOUGHT" }, { type: "text", text: "Looking." }] },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x.ts" } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "code" }] },
      { role: "assistant", content: "plain string reply" },
    ]);
    expect(s.text).not.toContain("SECRET THOUGHT");
    expect(briefOf(s.text)).toContain('Looking. (#0)\n* read "x.ts" (#1)');
    expect(briefOf(s.text)).toContain("plain string reply (#3)");
    expect(s.state.files.read).toEqual(["x.ts"]);
  });

  it("an image is a placeholder, a command the user ran a $ line", () => {
    const s = of([
      { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", data: "abc", mimeType: "image/png" }] },
      { role: "bashExecution", command: "ls -la", output: "files", exitCode: 0 },
    ]);
    expect(briefOf(s.text)).toContain("look at this (#0)\n[image: image/png] (#0)\n$ ls -la (#1)");
  });

  it("skips what it cannot read instead of throwing out of the compaction", () => {
    const s = of([
      { role: "custom", content: "an unknown role" },
      { role: "user", content: [{ type: "text", text: "fix it please" }, null, { type: "text" }] },
      { role: "assistant", content: [null, { type: "toolCall", id: "t", name: null, arguments: null }, { type: "text", text: "ok" }] },
      { role: "assistant", content: 42 },
      null,
    ]);
    expect(s.text).not.toContain("an unknown role");
    expect(briefOf(s.text)).toContain("fix it please (#1)");
    expect(briefOf(s.text)).toContain("* unknown (#2)\nok (#2)");
  });
});
