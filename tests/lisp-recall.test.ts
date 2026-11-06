// The Lisp core's recall against recall-run.ts recall(): generated projects (a
// current session and earlier ones, with branches, writes and edits, results,
// pins, titles, kept originals) and generated calls of the tool and the
// command (every action, scope, page and session, the loose forms the tool
// repairs, keys that are no param), the text and outcome compared, the core
// answering each itself. Skips without SBCL.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall, recallInCore, type RecallInput } from "../src/core/recall-run";
import { parseCommandRequest, parseToolRequest } from "../src/core/recall-request";
import { toolHints } from "../src/tools/recall";
import { commandHints } from "../src/commands/vcc-recall";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;
const root = mkdtempSync(join(tmpdir(), "omp-vcc-lisp-recall-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const WORDS = ["rounding", "bug", "deploy", "staging", "vault", "key", "release", "tag", "migrations", "café", "🎉", "src/money.ts", "fix", "the", "tests"];
const words = (r: () => number, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(" ");
const FILES = ["src/money.ts", "src/a.ts", "/repo/deep/nested/dir/b.ts", "README.md"];

/** One session file: header, entries on a main path with a side branch, and a store of originals. */
const sessionFile = (dir: string, id: string, r: () => number, size: number, mtime: number) => {
  const lines: string[] = [];
  if (r() < 0.5) lines.push(JSON.stringify({ type: "title", title: r() < 0.3 ? words(r, 20) : words(r, 3) }));
  lines.push(JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-0" + (1 + Math.floor(r() * 8)) + "T10:20:30.000Z", cwd: "/w" }));
  const entries: any[] = [];
  let parent: string | null = null;
  const store: string[] = [];
  const calls: string[] = [];
  for (let i = 0; i < size; i++) {
    const eid = `${id.slice(0, 4)}-${i}`;
    // A side branch now and then: an entry hung off an earlier one.
    const p = i > 3 && r() < 0.08 ? entries[Math.floor(r() * entries.length)].id : parent;
    const roll = r();
    let e: any;
    if (i === 0) e = { type: "message", message: { role: "user", content: r() < 0.5 ? words(r, 40) : words(r, 5) } };
    else if (roll < 0.2) e = { type: "message", message: { role: "user", content: pick(r, [words(r, 6), `look at ${pick(r, FILES)}`, "ok", words(r, 40)]) } };
    else if (roll < 0.5) {
      const parts: any[] = [{ type: "text", text: words(r, 8) }];
      if (r() < 0.7) {
        const cid = `c${eid}`;
        calls.push(cid);
        const path = pick(r, FILES);
        parts.push({ type: "toolCall", id: cid, ...pick(r, [
          { name: "write", arguments: { path, content: Array.from({ length: 1 + Math.floor(r() * (r() < 0.2 ? 900 : 60)) }, (_, k) => `line ${k} ${words(r, 3)}`).join("\n") } },
          { name: "edit", arguments: { path, edits: [{ oldText: words(r, 2), newText: words(r, 3) }] } },
          { name: "edit", arguments: { file_path: path, old_string: "a", new_string: "b" } },
          { name: "read", arguments: { path, i: "reading" } },
          { name: "bash", arguments: { command: `git commit -m "${words(r, 3)}"`, timeout: 30 } },
          { name: "vcc_recall", arguments: { query: words(r, 2) } },
          { name: "ast_edit", arguments: { paths: [path, "src/z.ts"], rule: "x" } },
        ]) });
      }
      e = { type: "message", message: { role: "assistant", content: parts } };
      // Its result right after it, now and then, as a host writes them.
      const last = parts[parts.length - 1];
      if (last?.type === "toolCall" && r() < 0.5) {
        entries.push({ type: e.type, id: eid, parentId: p, ...e });
        lines.push(JSON.stringify(entries[entries.length - 1]));
        parent = eid;
        e = { type: "message", message: { role: "toolResult", toolCallId: last.id, toolName: last.name, content: [{ type: "text", text: words(r, 15) }] } };
        const rid = `${eid}r`;
        e = { type: e.type, id: rid, parentId: eid, ...e };
        entries.push(e);
        parent = rid;
        lines.push(JSON.stringify(e));
        continue;
      }
    } else if (roll < 0.75 && calls.length) {
      e = { type: "message", message: { role: "toolResult", toolCallId: pick(r, calls), toolName: pick(r, ["bash", "read", "vcc_recall"]), content: [{ type: "text", text: r() < 0.1 ? "x".repeat(6000) : words(r, 12) }], ...(r() < 0.15 ? { prunedAt: 1 } : {}) } };
      if (e.message.prunedAt && r() < 0.7) store.push(JSON.stringify({ id: eid, content: [{ type: "text", text: `original ${words(r, 10)}` }] }));
    } else if (roll < 0.8) e = { type: "custom", customType: "omp-vcc.pin", data: { v: 1, op: "add", id: 1 + Math.floor(r() * 3), text: words(r, 4), by: "user" } };
    else if (roll < 0.83) e = { type: "session_info", name: words(r, 2) };
    else if (roll < 0.86) e = { type: "compaction", summary: words(r, 5), firstKeptEntryId: entries[0]?.id ?? "" };
    else e = { type: "message", message: { role: "bashExecution", command: "ls", output: words(r, 4), exitCode: 0 } };
    // Type first, then id and parentId, as both hosts write an entry (session-file.ts entryHead reads it so).
    e = { type: e.type, id: eid, parentId: p, ...e };
    entries.push(e);
    parent = eid;
    lines.push(JSON.stringify(e));
  }
  const file = join(dir, `2026-11-06T10-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  if (store.length) writeFileSync(`${file}.vcc-raw`, store.join("\n") + "\n");
  utimesSync(file, mtime, mtime);
  return { file, entries };
};

const project = (seed: number) => {
  const r = rng(seed);
  const dir = join(root, `p${seed}`);
  mkdirSync(dir, { recursive: true });
  const ids = ["019a1b2c-aaaa-7000-8000-000000000001", "019a1b2c-aaab-7000-8000-000000000002", "019a1b2c-bbbb-7000-8000-000000000003", "11112222-3333-4444-5555-666677778888"];
  const others = Array.from({ length: Math.floor(r() * 4) }, (_, k) => sessionFile(dir, ids[k], r, 5 + Math.floor(r() * 30), 1_700_000_000 + k * 100));
  const current = sessionFile(dir, "99999999-0000-7000-8000-00000000000a", r, 10 + Math.floor(r() * 50), 1_800_000_000);
  // The session manager's branch: the main path, from the last entry back to the root.
  const byId = new Map(current.entries.map((e) => [e.id, e]));
  const branch: any[] = [];
  for (let e = current.entries[current.entries.length - 1]; e; e = byId.get(e.parentId)) branch.unshift(e);
  const sm = { getSessionFile: () => current.file, getSessionDir: () => dir, getBranch: () => branch, getEntries: () => current.entries };
  return { sm, others, current, r };
};

const toolCall = (r: () => number, sessions: string[]): Record<string, unknown> => pick(r, [
  { query: words(r, 1 + Math.floor(r() * 3)) },
  { query: "rounding|deploy" }, { query: "fix.*tests" }, { query: "(?<n>x)" },
  { query: `#${Math.floor(r() * 40)}:${pick(r, ["file", "money", "a.ts", ".ts", "nope"])}${pick(r, ["", ":full", ":10", ":5:3", ":200"])}` },
  { expand: [Math.floor(r() * 40)] }, (() => { const n = Math.floor(r() * 40); return { expand: [n, n + 1, n + 2] }; })(),
  { expand: [1], page: 2 }, { query: "#3:file", page: 3 }, { mode: "sessions", query: "x", page: 2 },
  { query: `#${Math.floor(r() * 40)}:${pick(r, ["file", ".ts", "money"])}:${pick(r, ["25", "50:20", "58:5", "1", "full"])}` },
  { session: sessions[0], scope: "project", query: words(r, 1) }, { expand: `#${Math.floor(r() * 20)}, #${Math.floor(r() * 40)}` }, { expand: [3, 3, 9999] }, { expand: "x" },
  { range: [Math.floor(r() * 20), Math.floor(r() * 60)] }, { range: "10-5" }, { range: "#7" }, { range: [1, 2, 3] },
  { query: words(r, 1), page: pick(r, [2, "3", 0, "x"]) }, { range: [0, 100], page: 2 },
  { mode: "touched" }, { mode: "touched", page: 2 }, { mode: "sessions" }, { mode: "ALL", query: words(r, 1) }, { mode: "weird" },
  { query: words(r, 1), scope: pick(r, ["all", "project", "lineage", "nope", " All "]) },
  { session: pick(r, sessions), query: words(r, 1) }, { session: pick(r, sessions), expand: [1] }, { session: pick(r, sessions), mode: "touched" },
  { session: "019a", query: "x" }, { session: "@019a1b2caaaa", range: [0, 5] }, { session: "zz" }, { session: pick(r, sessions), scope: "project", query: "x" },
  { query: "", expand: [], foo: 1 }, {}, { query: 7 }, { query: words(r, 1), expand: [1], range: [1, 2], mode: "touched" },
]);

const commandArgs = (r: () => number, sessions: string[]): string => pick(r, [
  words(r, 2), `${words(r, 1)} scope:all`, `${words(r, 1)} scope:'project' page:2`, "sessions", "sessions page:2", `session:${pick(r, sessions)} ${words(r, 1)}`,
  `session:'${pick(r, sessions)}' sessions`, "", "#3:file", `page:"2" ${words(r, 1)}`,
]);

maybe("Lisp core recall", () => {
  it("answers generated tool and command calls as recall() does", () => {
    let compared = 0;
    let answered = 0;
    let targeted = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { sm, others, current, r } = project(seed);
      const sessions = [...others.map((o) => o.file.split("_").pop()!.replace(".jsonl", "").slice(0, 8)), "0000"];
      // Calls aimed at the current session's own writes and edits: their full content
      // (past the cap on a small window), a window of lines at the end, and with their results.
      const index = new Map<string, number>();
      let n = 0;
      for (const e of current.entries) if (e.type === "message") index.set(e.id, n++);
      const writes = current.entries.filter((e: any) => e.type === "message" && e.message.content?.some?.((c: any) => c.type === "toolCall" && ["write", "edit"].includes(c.name)));
      for (const w of writes.slice(0, 4)) {
        const at = index.get(w.id)!;
        for (const params of [{ query: `#${at}:file:full` }, { query: `#${at}:file:${pick(r, [1, 20, 55])}` }, { expand: [at, at + 1] }]) {
          for (const window of [8_000, undefined]) {
            const input: RecallInput = { request: parseToolRequest(params), sessionManager: sm, contextWindow: window, skipCurrentTurn: true, call: { surface: "tool", params } };
            const ts = withCore(undefined, () => recall(input, toolHints));
            expect({ seed, params, window, out: withCore(core, () => recallInCore(input as any)) }).toEqual({ seed, params, window, out: ts });
            targeted++;
          }
        }
      }
      for (let k = 0; k < 15; k++) {
        const window = pick(r, [undefined, 8_000, 32_000, 200_000]);
        const command = r() < 0.25;
        const input: RecallInput = command
          ? (() => { const args = commandArgs(r, sessions); return { request: parseCommandRequest(args), sessionManager: sm, contextWindow: window, call: { surface: "command" as const, name: "omp-vcc-recall", args } }; })()
          : (() => { const params = toolCall(r, sessions); return { request: parseToolRequest(params), sessionManager: sm, contextWindow: window, skipCurrentTurn: true, call: { surface: "tool" as const, params } }; })();
        const surface = command ? commandHints("omp-vcc-recall") : toolHints;
        const ts = withCore(undefined, () => recall(input, surface));
        // What a user gets with the core: its answer, or the TS one for a call it leaves to TS.
        expect({ seed, k, call: input.call, out: withCore(core, () => recall(input, surface)) }).toEqual({ seed, k, call: input.call, out: ts });
        const lisp = withCore(core, () => recallInCore(input as any));
        if (lisp) {
          expect({ seed, k, call: input.call, out: lisp }).toEqual({ seed, k, call: input.call, out: ts });
          answered++;
        }
        compared++;
      }
    }
    expect(compared).toBe(600);
    expect(targeted).toBeGreaterThan(100);
    // Only what the core refuses on purpose (a named group) goes to TS.
    expect(answered / compared).toBeGreaterThan(0.95);
  }, 300_000);
});
