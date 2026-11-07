import { describe, it, expect } from "bun:test";
import { summarize, UNCAPPED } from "./support/summary";

/** The brief a summary of these blocks shows, as it stores it. */
const compileBrief = (blocks: NormalizedBlock[]): string => summarize(blocks, { limits: UNCAPPED }).state.brief;
import type { NormalizedBlock } from "./support/compile";

describe("compileBrief", () => {
  it("returns empty string for no blocks", () => {
    expect(compileBrief([])).toBe("");
  });

  // Seen with a real model: a mode:'sessions' or expand call rendered as a bare `* keel_recall`.
  it("keel_recall and keel_pin lines say what was recalled or pinned", () => {
    const call = (name: string, args: Record<string, unknown>, sourceIndex: number): NormalizedBlock => ({ kind: "tool_call", name, args, sourceIndex });
    const r = compileBrief([
      call("keel_recall", { query: "build tag", scope: "project", i: "intent text" }, 1),
      call("keel_recall", { mode: "sessions" }, 2),
      call("keel_recall", { expand: "[1, 25]" }, 3),
      call("keel_recall", { session: "01a19511", range: [28, 34] }, 4),
      call("keel_recall", { query: "build tag", page: 2 }, 7),
      call("keel_pin", { note: "The deploy host has no Redis" }, 5),
      call("keel_pin", { unpin: 2 }, 6),
      call("keel_pin", { note: "refused", unpin: 3 }, 8),
    ]);
    expect(r).toContain(`* keel_recall "build tag" scope:project (#1)`);
    expect(r).toContain("* keel_recall mode:sessions (#2)");
    expect(r).toContain("* keel_recall expand:[1, 25] (#3)");
    expect(r).toContain("* keel_recall range:[28, 34] session:01a19511 (#4)");
    // Page 2 is another call than page 1, not a repeat of it.
    expect(r).toContain(`* keel_recall "build tag" page:2 (#7)`);
    expect(r).toContain(`* keel_pin "The deploy host has no Redis" (#5)`);
    expect(r).toContain("* keel_pin unpin:2 (#6)");
    // The tool refused a call with both: it pinned nothing, and the brief does not say it did.
    expect(r).toContain("* keel_pin (#8)");
    expect(r).not.toContain('"refused"');
    expect(r).not.toContain("intent text");
  });

  it("renders user and assistant text", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "fix auth bug" },
      { kind: "assistant", text: "Let me look at the auth module." },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("[user]");
    expect(r).toContain("fix auth bug");
    expect(r).toContain("[assistant]");
    expect(r).toContain("Let me look at the auth module.");
  });

  it("preserves assistant markdown line breaks", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "assistant",
        text: "Output nhìn tốt.\n\n```text\nblock #41: head\ntail\n```\n\n- first\n- second",
        sourceIndex: 96,
      },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("Output nhìn tốt.\n\n```text\nblock #41: head\ntail\n```\n\n- first\n- second (#96)");
  });

  it("preserves assistant line breaks when head/tail truncating", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line${i} signal${i}`);
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: lines.join("\n") },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("line0 signal0\nline1 signal1");
    expect(r).toContain("...(middle truncated)...");
    expect(r).toContain("\nline299 signal299");
  });

  it("names the files of a multi-path edit tool call", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "edit", args: { code: "...", paths: ["src/a.ts", "src/b.ts", "src/c.ts"] } },
    ];
    expect(compileBrief(blocks)).toContain('* edit "src/a.ts" +2');
  });

  it("renders bash commands as user actions", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "bash", command: "npm test", output: "FAIL noisy output", exitCode: 1, sourceIndex: 2 },
    ];
    const r = compileBrief(blocks);
    // exit 1: the line says it failed (the output stays behind keel_recall).
    expect(r).toContain("[user]\n$ npm test [failed] (#2)");
    expect(r).not.toContain("FAIL noisy output");
  });

  it("drops trivial preamble lines and surfaces the real command", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "set -euo pipefail\ngit add README.md\ngit commit -m \"fix\"\ngit push",
        output: "",
        exitCode: 0,
        sourceIndex: 3,
      },
    ];
    const r = compileBrief(blocks);
    // set -euo pipefail must not be the rendered marker; the git work must show.
    expect(r).toContain('git commit -m "fix"');
    expect(r).toContain("git push");
    expect(r).not.toMatch(/\$ set -euo pipefail/);
  });

  it("keeps a bare trivial command rather than emitting an empty marker", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "bash", command: "set -e", output: "", exitCode: 0, sourceIndex: 4 },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("$ set -e (#4)");
  });

  it("drops redirect-heredoc bodies but keeps the opener", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "cat > /tmp/pr.md <<'EOF'\n## Summary\n- a very long PR body line\nEOF\ngh pr create --body-file /tmp/pr.md",
        output: "",
        exitCode: 0,
        sourceIndex: 5,
      },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("cat > /tmp/pr.md <<'EOF'");
    expect(r).toContain("gh pr create --body-file /tmp/pr.md");
    // The body content must not leak into the brief.
    expect(r).not.toContain("a very long PR body line");
  });

  it("previews the first meaningful body line of an interpreter heredoc", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "python3 - <<'PY'\nimport csv\ntotal = sum(1 for _ in open('data.csv'))\nprint(total)\nPY",
        output: "",
        exitCode: 0,
        sourceIndex: 6,
      },
    ];
    const r = compileBrief(blocks);
    // Opener alone is content-free; a preview of the real work must appear.
    expect(r).toContain("python3 - <<'PY'");
    expect(r).toContain("total = sum(1 for _ in open('data.csv'))");
    // Boilerplate import must be skipped as the preview.
    expect(r).not.toMatch(/<<'PY' import csv/);
  });

  it("previews a non-allowlisted interpreter heredoc (sqlite3) via the denylist", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "sqlite3 app.db <<'SQL'\nSELECT count(*) FROM users;\nSQL",
        output: "",
        exitCode: 0,
        sourceIndex: 7,
      },
    ];
    const r = compileBrief(blocks);
    // sqlite3 is not a file-writer, so its content-free opener gets a preview.
    expect(r).toContain("sqlite3 app.db <<'SQL'");
    expect(r).toContain("SELECT count(*) FROM users;");
  });

  it("previews an ssh remote-command heredoc body", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "ssh deploy@host <<'CMD'\nsudo systemctl restart api\nCMD",
        output: "",
        exitCode: 0,
        sourceIndex: 8,
      },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("ssh deploy@host <<'CMD'");
    expect(r).toContain("sudo systemctl restart api");
  });

  it("previews an interpreter heredoc combined with a redirect", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "python3 - <<'PY' > /tmp/out.sh\nprint('build config')\nPY\nbash /tmp/out.sh",
        output: "",
        exitCode: 0,
        sourceIndex: 9,
      },
    ];
    const r = compileBrief(blocks);
    // The `>` redirect must not suppress the body preview (old lookahead bug).
    expect(r).toContain("print('build config')");
    // The command after the heredoc terminator must survive.
    expect(r).toContain("bash /tmp/out.sh");
  });

  it("does not treat `<<` shift operators as a heredoc opener", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "n=$((1<<10))\ngit commit -m shift",
        output: "",
        exitCode: 0,
        sourceIndex: 10,
      },
    ];
    const r = compileBrief(blocks);
    // `1<<10` is a bit-shift, not a heredoc: the commit below must not be eaten.
    expect(r).toContain("git commit -m shift");
  });

  it("does not eat following commands when a `<<` has no closing terminator", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "echo \"see <<NOTE for details\"\nnpm run build",
        output: "",
        exitCode: 0,
        sourceIndex: 11,
      },
    ];
    const r = compileBrief(blocks);
    // `<<NOTE` has no closing `NOTE` line, so it is not a heredoc opener.
    expect(r).toContain("npm run build");
  });

  it("strips filler prefixes but preserves meaningful lead-ins", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Okay, I found the root cause." },
      { kind: "assistant", text: "Actually, the issue is in middleware." },
      { kind: "assistant", text: "Let me check the logs." },
    ];
    expect(compileBrief(blocks)).toBe("[assistant]\nI found the root cause.\nthe issue is in middleware.\nLet me check the logs.");
  });

  it("collapses tool calls to one-liners under [assistant]", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Let me check." },
      { kind: "tool_call", name: "Read", args: { file_path: "auth.ts" } },
      { kind: "tool_call", name: "Edit", args: { file_path: "auth.ts" } },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain('* Read "auth.ts"');
    expect(r).toContain('* Edit "auth.ts"');
    // Should merge into single [assistant] section
    const matches = r.match(/\[assistant\]/g);
    expect(matches?.length).toBe(1);
  });

  it("hides tool results, whatever they say", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "Read", text: "const x = 1;\nconst y = 2;\n// lots of code" },
      { kind: "tool_result", name: "bash", text: "FAIL auth.test.ts\nexpected 200 got 401" },
    ];
    expect(compileBrief(blocks)).toBe("");
  });

  it("merges adjacent assistant sections", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "First part." },
      { kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
      // No user/tool_result between these — should merge
      { kind: "assistant", text: "Second part." },
      { kind: "tool_call", name: "Read", args: { file_path: "b.ts" } },
    ];
    const r = compileBrief(blocks);
    const matches = r.match(/\[assistant\]/g);
    expect(matches?.length).toBe(1);
  });

  it("does NOT merge assistant after user", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "First." },
      { kind: "user", text: "Next task." },
      { kind: "assistant", text: "Second." },
    ];
    const r = compileBrief(blocks);
    const matches = r.match(/\[assistant\]/g);
    expect(matches?.length).toBe(2);
  });

  it("truncates long user text", () => {
    const longText = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: longText },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("(truncated)");
    expect(r).not.toContain("word299");
  });

  // The text that closes a turn (nothing but tool results before the next user
  // message) keeps a longer head: it is usually the answer.
  it("truncates segment-closing assistant text with head and tail, the head 120 words", () => {
    const longText = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: longText },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("word119\n...(middle truncated)...\nword480");
    expect(r).toContain("word0");
    expect(r).toContain("word599");
  });

  it("truncates non-closing assistant text with head and tail, the head 80 words", () => {
    const longText = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: longText },
      { kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
    ];
    const r = compileBrief(blocks);
    expect(r).toContain("word79\n...(middle truncated)...\nword480");
    expect(r).toContain("word0");
    expect(r).toContain("word599");
  });

  it("renders a realistic conversation flow", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "fix the login bug" },
      { kind: "assistant", text: "Let me investigate." },
      { kind: "tool_call", name: "Read", args: { file_path: "login.ts" } },
      { kind: "tool_result", name: "Read", text: "export function login() { ... }" },
      { kind: "tool_call", name: "bash", args: { command: "npm test" } },
      { kind: "tool_result", name: "bash", text: "FAIL: login test\nExpected true, got false" },
      { kind: "assistant", text: "The test is failing because..." },
      { kind: "tool_call", name: "Edit", args: { file_path: "login.ts" } },
      { kind: "tool_result", name: "Edit", text: "File edited successfully" },
      { kind: "user", text: "test lại đi" },
      { kind: "assistant", text: "Running tests again." },
      { kind: "tool_call", name: "bash", args: { command: "npm test" } },
      { kind: "tool_result", name: "bash", text: "All tests passed" },
    ];
    const r = compileBrief(blocks);

    // Check structure
    expect(r).toContain("[user]\nfix the login bug");
    expect(r).toContain('[assistant]\nLet me investigate.\n* Read "login.ts"');
    expect(r).toContain('* bash "npm test"');
    expect(r).toContain('The test is failing because...\n* Edit "login.ts"');
    expect(r).toContain("[user]\ntest lại đi");
    expect(r).toContain('[assistant]\nRunning tests again.\n* bash "npm test"');

    // Hidden content
    expect(r).not.toContain("export function login");
    expect(r).not.toContain("File edited successfully");
    expect(r).not.toContain("All tests passed");
  });

  it("a hidden tool result does not split the assistant's turn", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Checking files." },
      { kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
      { kind: "tool_result", name: "Read", text: "..." },
      { kind: "tool_call", name: "Read", args: { file_path: "b.ts" } },
      { kind: "tool_result", name: "Read", text: "..." },
    ];
    expect(compileBrief(blocks)).toBe('[assistant]\nChecking files.\n* Read "a.ts"\n* Read "b.ts"');
  });

  it("does not cap when tool calls per turn <= 8", () => {
    const blocks: NormalizedBlock[] = [{ kind: "assistant", text: "ok" }];
    for (let i = 1; i <= 8; i++) {
      blocks.push({ kind: "tool_call", name: "bash", args: { command: `c${i}` } });
    }
    const r = compileBrief(blocks);
    expect(r).not.toContain("entries omitted");
    expect(r).toContain("c1");
    expect(r).toContain("c8");
  });
});

describe("failed tool calls", () => {
  it("a call whose result is an error says so, before its ref", () => {
    const r = summarize({ messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun test tests/billing.test.ts" } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "1 fail" }], isError: true },
      { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "bun test tests/billing.test.ts" } }] },
      { role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "12 pass" }], isError: false },
    ] }, { sourceIndices: [10, 11, 12, 13] }).state.brief;
    expect(r).toContain('* bash "bun test tests/billing.test.ts" [failed] (#10)');
    expect(r).toContain('* bash "bun test tests/billing.test.ts" (#12)');
  });
});

describe("tool lines", () => {
  it("a search shows its pattern, whatever the host's casing", () => {
    const brief = compileBrief([
      { kind: "tool_call", name: "grep", args: { pattern: "authRetry", path: "src" }, sourceIndex: 1 },
      { kind: "tool_call", name: "Grep", args: { pattern: "billingRetry" }, sourceIndex: 2 },
      { kind: "tool_call", name: "ast_grep", args: { pat: "retry($A)", path: "src" }, sourceIndex: 3 },
    ]);
    expect(brief).toContain('* grep "authRetry" (#1)');
    expect(brief).toContain('* Grep "billingRetry" (#2)');
    expect(brief).toContain('* ast_grep "retry($A)" (#3)');
  });

  it("identical calls in a row are one line with every #N; markdown bullets in the text are not calls", () => {
    const brief = compileBrief([
      { kind: "assistant", text: "Checked:\n* tests pass", sourceIndex: 1 },
      { kind: "assistant", text: "* tests pass", sourceIndex: 2 },
      { kind: "tool_call", name: "read", args: { path: "a.ts" }, sourceIndex: 2 },
      { kind: "tool_call", name: "read", args: { path: "a.ts" }, sourceIndex: 3 },
    ]);
    expect(brief).toContain("* tests pass (#1)\n* tests pass (#2)");
    expect(brief).toContain('* read "a.ts" (#2, #3) x2');
  });

  it("past eight calls in a turn the earliest are counted, not shown; text lines stay", () => {
    const blocks: NormalizedBlock[] = [{ kind: "assistant", text: "* a bullet, not a call", sourceIndex: 0 }];
    for (let i = 1; i <= 10; i++) blocks.push({ kind: "tool_call", name: "read", args: { path: `f${i}.ts` }, sourceIndex: i });
    const brief = compileBrief(blocks);
    expect(brief).toContain("* a bullet, not a call (#0)");
    expect(brief).toContain("* (2 earlier tool-call entries omitted)");
    expect(brief).not.toContain('"f2.ts"');
    expect(brief).toContain('* read "f3.ts" (#3)');
  });
});
