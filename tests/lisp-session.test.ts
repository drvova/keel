// The Lisp core's reading of a session file against load-messages.ts: the
// same generated files, every entry's #N, role, summary, files and search text
// compared, on every branch filter. Skips without SBCL.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, renderMessages } from "../src/core/load-messages";
import { rawSearchText } from "../src/core/search-entries";
import { callCore } from "../src/core/lisp-core";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), "omp-vcc-lisp-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const WORDS = ["fix", "the", "rounding", "bug", "in", "src/money.ts", "café", "Привет", "日本語", "🎉", "👨‍👩‍👧", "artifact://x", "a", "long-word-without-spaces"];
const words = (r: () => number, n: number): string => Array.from({ length: n }, () => pick(r, WORDS)).join(r() < 0.1 ? "\n" : " ");
// Around the 200 and 300 clips, with a pair straddling them now and then.
const text = (r: () => number): string => {
  const t = words(r, 1 + Math.floor(r() * (r() < 0.3 ? 80 : 10)));
  return r() < 0.15 ? `${"x".repeat(199)}🎉${t}` : r() < 0.1 ? `${"y".repeat(299)}🎉 ${t}` : t;
};

const CALLS = (r: () => number): Record<string, unknown>[] => [
  { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts:50-100" } },
  { type: "toolCall", id: "c2", name: "write", arguments: { path: "src/b.ts", content: text(r) } },
  { type: "toolCall", id: "c3", name: "edit", arguments: { path: "src/c.ts", edits: [{ oldText: "a", newText: text(r) }, "loose"] } },
  { type: "toolCall", id: "c4", name: "edit", arguments: { input: "[src/h.ts#1A2b]\n+line\n[src/h.ts#0000]  \n[bad#12]\n" } },
  { type: "toolCall", id: "c5", name: "apply_patch", arguments: { input: "*** Begin Patch\r\n*** Update File: src/p.py \t\r\n*** Move to:  src/q.py\n*** Add File:  \n*** Delete File: \t \n" } },
  { type: "toolCall", id: "c6", name: "ast_edit", arguments: { paths: ["x.ts", "", 3, "y.ts"] } },
  { type: "toolCall", id: "c7", name: "grep", arguments: { pattern: "TODO", path: "src" } },
  { type: "toolCall", id: "c8", name: "Grep", arguments: { pat: "FIXME" } },
  { type: "toolCall", id: "c9", name: "bash", arguments: { command: `bun test ${words(r, 3)}` } },
  { type: "toolCall", id: "c10", name: "bash", arguments: {} },
  { type: "toolCall", id: "c11", name: "my_writer", arguments: { file_path: "w.md", content: "hi" } },
  { type: "toolCall", id: "c12", name: "web", arguments: { query: "sbcl manual" } },
  { type: "toolCall", id: "c13", name: "noargs", arguments: { b: 1, "2": "two", a: [1, "s", { k: "v", n: 2 }], "01": "x" } },
  { type: "toolCall", id: "c14", name: "vcc_recall", arguments: { query: "rounding" } },
  { type: "toolCall", id: "c15", name: 42, arguments: [1, 2] },
  { type: "toolCall", id: "c16", name: "constructor", arguments: { filePath: "k.ts" } },
];

const message = (r: () => number): unknown => {
  const roll = r();
  if (roll < 0.15) return { role: "user", content: r() < 0.5 ? text(r) : [{ type: "text", text: text(r) }, { type: "image", data: "AAAA" }] };
  if (roll < 0.35) {
    const calls = CALLS(r).filter(() => r() < 0.25);
    return { role: "assistant", content: [{ type: "text", text: text(r) }, ...calls, null, { type: "text", text: 7 }] };
  }
  if (roll < 0.5) {
    const toolName = pick(r, ["read", "bash", "vcc_recall", "VCC_RECALL", undefined]);
    return { role: "toolResult", toolCallId: "c1", ...(toolName ? { toolName } : {}), content: [{ type: "text", text: text(r) }], ...(r() < 0.3 ? { prunedAt: 1 } : {}) };
  }
  if (roll < 0.55) return { role: "bashExecution", command: r() < 0.8 ? `ls ${words(r, 2)}` : null, output: r() < 0.8 ? text(r) : 3 };
  if (roll < 0.6) return { role: "pythonExecution", code: "print(1)", output: text(r) };
  if (roll < 0.65) return { role: "fileMention", files: [{ path: "src/m.ts" }, { path: "" }, { path: 5 }, "x"] };
  if (roll < 0.7) return { role: pick(r, ["developer", "custom", "system"]), content: text(r) };
  if (roll < 0.75) return { role: "assistant", content: null };
  if (roll < 0.78) return { role: "assistant", content: 12 };
  if (roll < 0.8) return { role: "assistant" };
  if (roll < 0.82) return { role: "user", content: [{ type: "text", text: `see artifact://shaken ${text(r)}` }, { type: "toolCall", name: "read", arguments: { path: "z" } }] };
  if (roll < 0.84) return "not an object";
  return { role: "assistant", content: [{ type: "text", text: text(r) }] };
};

/** A session file with branches, non-message entries, bad lines and a store of originals. */
const writeSession = (seed: number, parentSession?: string): string => {
  const r = rng(seed);
  const file = join(dir, `2026-11-06_${seed}.jsonl`);
  const lines: string[] = [];
  if (r() < 0.5) lines.push(JSON.stringify({ type: "title", title: `t${seed}` }));
  lines.push(JSON.stringify({ type: "session", version: 3, id: `s${seed}`, cwd: "/w", ...(parentSession ? { parentSession } : {}) }));
  const ids: string[] = [];
  const store: string[] = [];
  const count = 10 + Math.floor(r() * 60);
  for (let i = 0; i < count; i++) {
    const id = r() < 0.05 && ids.length ? pick(r, ids) : `e${seed}-${i}`;
    // Mostly a chain; a fork back to an earlier entry now and then.
    const parentId = ids.length === 0 ? null : r() < 0.1 ? pick(r, ids) : ids[ids.length - 1];
    const roll = r();
    if (roll < 0.05) lines.push(JSON.stringify({ type: "compaction", id, parentId, summary: "s" }));
    else if (roll < 0.08) lines.push(JSON.stringify({ type: "reset_boundary", id, parentId }));
    else if (roll < 0.1) lines.push("{not json");
    else if (roll < 0.12) lines.push("");
    else if (roll < 0.13) lines.push(JSON.stringify({ type: "message", id, parentId, message: null }));
    else {
      const m = message(r);
      lines.push(JSON.stringify({ type: "message", id, parentId, message: m }));
      if (r() < 0.4) store.push(JSON.stringify({ id, content: r() < 0.5 ? `original ${text(r)}` : [{ type: "text", text: `kept ${text(r)}` }] }));
    }
    ids.push(id);
  }
  writeFileSync(file, lines.join("\n") + (r() < 0.8 ? "\n" : ""));
  if (store.length) writeFileSync(`${file}.vcc-raw`, store.join("\n") + "\n");
  return file;
};

const tsLoad = (file: string, ids: "active" | string[] | null, skip: number[] = []) => {
  const read = readSession(file);
  const allowed = ids === "active" ? (read.branchIds.size > 0 ? read.branchIds : undefined) : ids ? new Set(ids) : undefined;
  return renderMessages(read.messages, false, allowed)
    .filter((m) => !skip.includes(m.entry.index))
    .map((m) => ({ index: m.entry.index, role: m.entry.role, summary: m.entry.summary, ...(m.entry.files ? { files: m.entry.files } : {}), text: rawSearchText(m.message, m.entry) }));
};

const lispLoad = (file: string, ids: "active" | string[] | null, skip: number[] = []) =>
  withCore(core, () => callCore({ op: "load", source: { file, ids, skip } }))?.entries;

maybe("Lisp core session reading", () => {
  it("reads generated sessions as load-messages.ts does, on every branch filter", () => {
    let compared = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const parent = seed > 1 && seed % 4 === 0 ? `s${seed - 1}` : undefined;
      const file = writeSession(seed, parent);
      const r = rng(seed * 31);
      const someIds = readSession(file).messages.map((m) => m.id).filter((id): id is string => !!id && r() < 0.5);
      const skip = [1, 2, 5].filter(() => r() < 0.5);
      for (const [ids, sk] of [[null, []], ["active", []], [someIds, skip], ["active", skip]] as const) {
        const ts = tsLoad(file, ids as any, [...sk]);
        expect({ seed, ids, entries: lispLoad(file, ids as any, [...sk]) }).toEqual({ seed, ids, entries: ts });
        compared += ts.length;
      }
    }
    expect(compared).toBeGreaterThan(2000);
  });

  it("puts back a fork's originals from its parent's store", () => {
    const parent = join(dir, "2026-11-06_parent-fork.jsonl");
    writeFileSync(parent, [
      JSON.stringify({ type: "session", id: "pf" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "[Output truncated - 9 tokens]" }], prunedAt: 1 } }),
    ].join("\n") + "\n");
    writeFileSync(`${parent}.vcc-raw`, `${JSON.stringify({ id: "m1", content: [{ type: "text", text: "the whole original output" }] })}\n`);
    const child = join(dir, "2026-11-06_child-fork.jsonl");
    writeFileSync(child, [
      JSON.stringify({ type: "session", id: "cf", parentSession: "parent-fork" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "[Output truncated - 9 tokens]" }], prunedAt: 1 } }),
    ].join("\n") + "\n");
    const entries = lispLoad(child, null);
    expect(entries).toEqual(tsLoad(child, null));
    expect((entries as any)[0].summary).toBe("[read] the whole original output");
  });

  it("reads a missing file as an empty session", () => {
    expect(lispLoad(join(dir, "none.jsonl"), null)).toEqual([]);
    expect(tsLoad(join(dir, "none.jsonl"), null)).toEqual([]);
  });
});
