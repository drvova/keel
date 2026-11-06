// The Lisp core's summary against summarize.ts compileSummary: generated
// windows of every message shape, compacted one after another (each merging
// into the state the last stored), and from summaries an older version or
// another compactor wrote; the text, the stored state and the sections
// compared. Skips without SBCL.
import { describe, expect, it } from "bun:test";
import { compileSummary, type CompileInput } from "../src/core/summarize";
import { DEFAULT_SUMMARY_LIMITS } from "../src/core/window";
import { callCore } from "../src/core/lisp-core";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const some = <T>(r: () => number, xs: readonly T[], p = 0.3): T[] => xs.filter(() => r() < p);

const WORDS = ["fix", "the", "rounding", "bug", "in", "money.ts", "and", "run", "tests", "please", "café", "Привет", "🎉", "deploy",
  "never", "use", "rm", "-rf", "always", "keep", "migrations", "untouched", "because", "staging", "breaks", "ok", "it's", "v2.6.8", "a_b"];
const words = (r: () => number, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(pick(r, [" ", " ", " ", "  ", "\n", " \t"]));

const COMMANDS = (r: () => number): string[] => [
  `git commit -m "fix: ${words(r, 3)}"`,
  `git add -A && git commit -qm 'feat: ${words(r, 2)}' && git push`,
  `git commit -m "$(cat <<'EOF'\nrefactor: ${words(r, 3)}\n\nbody\nEOF\n)"`,
  `git commit -F - <<EOF\ndocs: ${words(r, 2)}\nEOF`,
  "git commit --amend --no-edit",
  `git commit --amend -m "fix: amended ${words(r, 1)}"`,
  "git rev-parse --short HEAD",
  "set -euo pipefail\ncd src\nbun test 2>&1 | tail -20",
  "cd /repo && npm run build | head -5",
  `cat > notes.md <<EOF\n${words(r, 4)}\nEOF`,
  "python3 - <<PY\nimport os\nprint(os.getcwd())\nPY",
  "ls -la", "echo hi", "pwd", "sudo -u root kubectl get pods -n prod; kubectl logs api",
  "env FOO=1 docker compose up -d && docker ps", "ssh -i key host 'kubectl get svc; docker ps'", "x=1 kubectl apply -f k.yaml # don't",
  "gh pr view 12", "gh pr checks 12", `echo "a; kubectl delete pod" 2>&1`, "time docker build .",
  "kubectl logs api 2>&1 | grep err; kubectl get ns", "docker ps &>/dev/null; docker images", "docker run x >&2 && kubectl top pods",
  `python3 - <<PY\nprint("${"long ".repeat(30)}")\nPY`,
];

const TOOL_CALLS = (r: () => number): Record<string, unknown>[] => [
  { name: "read", arguments: { path: pick(r, ["src/money.ts", "src/money.ts:10-20", "/repo/src/a.ts", "/repo/src/b.ts", "artifact://x", "/etc/hosts", "/var/log/x.log"]) } },
  { name: "write", arguments: { path: pick(r, ["src/new.ts", "src/money.ts", "/repo/src/c.ts"]), content: words(r, 5) } },
  { name: "edit", arguments: { path: pick(r, ["src/money.ts", "/repo/src/a.ts"]), edits: [{ oldText: "a", newText: "b" }] } },
  { name: "edit", arguments: { input: "[src/h.ts#1A2b]\n+x\n" } },
  { name: "grep", arguments: { pattern: "TODO", path: "src" } },
  { name: "bash", arguments: { command: pick(r, COMMANDS(r)) } },
  { name: "vcc_recall", arguments: pick(r, [{ query: "rounding" }, { query: "x", page: 2, scope: "project" }, { expand: [1, 25] }, { mode: "sessions", page: "1" }, {}]) },
  { name: "vcc_pin", arguments: pick(r, [{ note: "Never edit migrations." }, { unpin: 2 }, { note: "a", unpin: 1 }, {}]) },
  { name: "web_search", arguments: { query: words(r, 12) } },
  { name: "noargs", arguments: {} },
  { name: "", arguments: {} },
];

const RESULTS = (r: () => number): string[] => [
  "[main abc1234] fix: something", "[main (root-commit) 0f1e2d3] feat: start", "abc1234..def5678  main -> main",
  "deadbee", "1234567", "def4567 (HEAD -> main) docs: x", words(r, 30), "x".repeat(1200), "",
];

const message = (r: () => number, ids: string[]): unknown => {
  const roll = r();
  if (roll < 0.2) {
    const text = pick(r, [
      words(r, 4 + Math.floor(r() * 30)), "ok", "<peer_message from=x>hi</peer_message>", `<system-reminder>be nice</system-reminder>${words(r, 5)}`,
      "<system-reminder>only this</system-reminder>", `<skill name="deploy">steps\nmore</skill> ${words(r, 6)}`, words(r, 120), "Hmm, wait — " + words(r, 5),
      words(r, 400), `see https://example.com/${"a".repeat(150)}/x then ${words(r, 20)}`, `\u001b[31mred\u001b[0m ${words(r, 4)}\u0007\u0001`,
    ]);
    return r() < 0.3
      ? { role: "user", content: [{ type: "text", text }, { type: "image", mimeType: "image/png", data: "AA" }] }
      : { role: "user", content: text, ...(r() < 0.1 ? { injected: true } : {}) };
  }
  if (roll < 0.55) {
    const parts: unknown[] = [];
    if (r() < 0.7) parts.push({ type: "text", text: pick(r, ["Hmm, actually " + words(r, 10), words(r, 3), words(r, 260), "Okay. " + words(r, 40)]) });
    const calls = some(r, TOOL_CALLS(r), 0.2);
    // The same call again and again, as a polling loop makes it: the brief merges them (x3).
    if (r() < 0.15) calls.push(...Array(3).fill({ name: "bash", arguments: { command: "gh pr checks 12" } }));
    for (const c of calls) {
      const id = `c${ids.length}`;
      ids.push(id);
      parts.push({ type: "toolCall", id, ...c });
    }
    return { role: "assistant", content: r() < 0.05 ? words(r, 8) : parts };
  }
  if (roll < 0.8 && ids.length) {
    return { role: "toolResult", toolCallId: pick(r, ids), toolName: "bash", content: [{ type: "text", text: pick(r, RESULTS(r)) }], ...(r() < 0.2 ? { isError: true } : {}) };
  }
  if (roll < 0.88) return { role: "bashExecution", command: pick(r, COMMANDS(r)), output: pick(r, RESULTS(r)), exitCode: pick(r, [0, 0, 1, undefined]) };
  if (roll < 0.91) return { role: "pythonExecution", code: "import x\nprint(1)\n", output: "1", exitCode: 0 };
  if (roll < 0.93) return { role: "custom", content: "x" };
  if (roll < 0.95) return null;
  return { role: "assistant", content: [{ type: "text", text: words(r, 2) }] };
};

const window = (r: () => number, start: number, size: number, ids: string[]) => {
  const messages = Array.from({ length: size }, () => message(r, ids));
  const sourceIndices = messages.map((_, i) => (r() < 0.05 ? undefined : start + i));
  return { messages, sourceIndices };
};

/** Both sides; `answered` says the core gave the summary itself rather than leaving it to TS. */
const both = (input: CompileInput) => ({
  ts: withCore(undefined, () => compileSummary(input)),
  lisp: withCore(core, () => compileSummary(input)),
  answered: withCore(core, () => callCore({ op: "summarize", input })) !== undefined,
});

maybe("Lisp core summary", () => {
  it("compiles generated sessions, compaction after compaction, as compileSummary does", () => {
    let compared = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const ids: string[] = [];
      const small = r() < 0.4;
      const limits = small ? { userMessages: 4, filesPerCategory: 3, commits: 2, historyRanges: 3, briefLines: 30, commandsPerName: 3 } : DEFAULT_SUMMARY_LIMITS;
      let previous: CompileInput["previous"];
      let previousSummary: string | undefined;
      let at = 0;
      for (let pass = 0; pass < 4; pass++) {
        const size = 5 + Math.floor(r() * 60);
        const { messages, sourceIndices } = window(r, at, size, ids);
        at += size;
        const input: CompileInput = {
          messages: messages as any,
          ...(previous ? { previous } : {}),
          ...(previousSummary ? { previousSummary } : {}),
          sourceIndices,
          fileOps: { read: some(r, ["src/x.ts", "src/money.ts", "skill://a"]), changed: some(r, ["src/y.ts", "/repo/src/a.ts"]) },
          trackCommands: some(r, ["kubectl", "docker", "ssh", "git"], 0.5),
          limits,
          ranking: r() < 0.5
            ? { maxBriefChars: 2000 + Math.floor(r() * 3000), maxBriefCharsCeiling: 8000, briefCharsPerBlock: 60, maxBlocks: 20 + Math.floor(r() * 60) }
            : r() < 0.5 ? { maxBlocks: 10 } : undefined,
          ...(r() < 0.4 ? { pinnedNotes: r() < 0.3
            ? Array.from({ length: 23 }, (_, i) => ({ id: i + 1, text: `note ${i}`, by: "user" as const }))
            : [{ id: 1, text: "Never edit migrations/.", by: "user" as const, at: 3 }, { id: 2, text: "Use bun.", by: "agent" as const }] } : {}),
          ...(r() < 0.4 ? { historyIndex: [
            { from: 0, to: 9, asks: [], files: [], commits: [], commitCount: 0, failed: 0 },
            { from: 10, to: 40, requests: 2, asks: ["fix the bug", "x"], files: ["src/a/b.ts", "c.ts", "d/e/f.ts", "g/h.ts"], commits: ["abc1234 fix"], commitCount: 3, failed: 1 },
            { from: 41, to: 50, requests: 1, asks: ["y"], files: ["one.ts"], commits: ["def5678 x"], commitCount: 1, failed: 0 },
            { from: 51, to: 90, requests: 4, asks: ["z"], files: Array.from({ length: 24 }, (_, i) => `d${i % 8}/f${i}.ts`), commits: [], commitCount: 0, failed: 2 },
          ] } : {}),
          ...(r() < 0.3 ? { workingSet: ["--- src/money.ts (#4)", "const x = 1;"] } : {}),
        };
        const { ts, lisp, answered } = both(input);
        expect({ seed, pass, ...lisp }).toEqual({ seed, pass, ...ts });
        if (answered) compared++;
        // The next window merges into the stored state, or, now and then, into the text alone
        // (a summary from before the state was stored, or one another compactor wrote).
        if (r() < 0.25) {
          previous = undefined;
          previousSummary = ts.text;
        } else {
          previous = ts.state;
          previousSummary = ts.text;
        }
      }
    }
    expect(compared).toBe(100);
  }, 120_000);

  it("reads older summaries and other compactors' as compileSummary does", () => {
    const older = [
      "[Session Goal]\n- [skill: deploy]\n- Ship the release\n\n[Files And Changes]\n- Modified: f3.ts, g.ts\n- Read: a.ts (+2 more)\n\n[Commits]\n- abc1234: fix x\n- plain subject\n\n---\n\n[user]\nhi\n\n---\n\nUse `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already\ncompleted.",
      "[Early Session Requests]\n- first\n- second\n\n[Tracked Commands]\n- kubectl: (+3 earlier) get pods | logs api\n\n[User Messages]\n- one\n- two <skill x>\n\n---\n\nbrief text",
      "The user asked to fix the build; it was fixed. Next: deploy.",
      "",
    ];
    for (const [i, previousSummary] of older.entries()) {
      for (const foreign of [false, true]) {
        const input: CompileInput = {
          messages: [
            { role: "user", content: "Now deploy the fixed build to staging" },
            { role: "assistant", content: [{ type: "toolCall", id: "w", name: "write", arguments: { path: "/repo/src/f3.ts", content: "x" } }] },
          ] as any,
          previousSummary, previousSummaryForeign: foreign, limits: DEFAULT_SUMMARY_LIMITS, trackCommands: ["kubectl"],
        };
        const { ts, lisp, answered } = both(input);
        expect({ i, foreign, answered, ...lisp }).toEqual({ i, foreign, answered: true, ...ts });
      }
    }
  });

  it("leaves text in scripts segmented by dictionary to the TS code", () => {
    const input: CompileInput = { messages: [{ role: "user", content: "请修复这个错误" }] as any, limits: DEFAULT_SUMMARY_LIMITS };
    const { ts, lisp, answered } = both(input);
    expect(answered).toBe(false);
    expect(lisp).toEqual(ts);
  });
});
