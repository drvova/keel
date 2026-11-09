// [History Index]: each compaction's window as a #N range, carried in the
// compaction's details and merged down to the window's line limit. The core
// builds it (lisp/src/compaction.lisp) and writes it (lisp/src/summary.lisp).
import { DEFAULT_SUMMARY_LIMITS } from "./support/window";
import { describe, expect, it } from "bun:test";
import type { HistoryRange } from "./support/compile";
import { COMPACT_INSTRUCTION } from "./support/names";
import { registerHook } from "./support/host";
import { sectionLines, summarize } from "./support/summary";
import { tempConfig } from "./support/config";

const range = (from: number, to: number, extra: Partial<HistoryRange> = {}): HistoryRange =>
  ({ from, to, requests: 1, asks: [`ask ${from}`], files: [], commits: [], commitCount: 0, failed: 0, ...extra });

const config = tempConfig("keel-index-", { overrideDefaultCompaction: true, smartKeepTail: false });

/** The compaction the hook writes of this branch: an automatic one, or /keel keep:N. */
const compact = (branchEntries: any[], opts: { previousSummary?: string; keep?: number } = {}) => {
  let handler: any;
  const hook = registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
  if (opts.keep === undefined) hook.autoCompactionStart("threshold");
  return handler({
    type: "session_before_compact", branchEntries,
    customInstructions: opts.keep === undefined ? undefined : `${COMPACT_INSTRUCTION} keep:${opts.keep}`,
    preparation: { previousSummary: opts.previousSummary, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
    signal: new AbortController().signal,
  }, { ui: { notify: () => {} }, sessionManager: { getEntries: () => branchEntries } }).compaction;
};

const entry = (id: string, message: any) => ({ id, type: "message", message });
const say = (id: string, role: "user" | "assistant", text: string) =>
  entry(id, role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] });
/** Ten exchanges' worth of #N already behind a compaction, which stored INDEX. */
const behind = (index: unknown, compactor = "keel", wrap = false) => {
  const done = Array.from({ length: 10 }, (_, i) => say(`old${i}`, i % 2 ? "assistant" : "user", `old request ${i}`));
  const details = { compactor, version: 2, historyIndex: index };
  return [...done, { id: "k0", type: "compaction", firstKeptEntryId: "", summary: "[user]\nold", details: wrap ? { kind: "experimental-context-rollover", hookDetails: details } : details }];
};
/** A reply long enough that summarizing it shrinks the context, so the growth guard lets the compaction be written. */
const long = (id: string) => say(id, "assistant", `done: ${"the work went as planned and every check passed. ".repeat(80)}`);
const fresh = () => [say("n1", "user", "the next request please"), long("n2"), say("n3", "user", "and another one"), say("n4", "assistant", "ok")];

describe("a window's range", () => {
  it("records the range, requests, longest asks, changed files, commits and failed calls", () => {
    const c = compact([
      entry("a", { role: "user", content: "short ask here" }),
      entry("b", { role: "user", content: "a much longer ask that carries the actual requirement" }),
      entry("c", { role: "assistant", content: [{ type: "toolCall", id: "e", name: "edit", arguments: { path: "src/auth/session.ts", oldText: "a", newText: "b" } }] }),
      entry("d", { role: "toolResult", toolCallId: "e", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false }),
      entry("e", { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "bun test" } }] }),
      entry("f", { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "1 fail" }], isError: true }),
      entry("g", { role: "assistant", content: [{ type: "toolCall", id: "g", name: "bash", arguments: { command: 'git commit -m "fix: auth"' } }] }),
      entry("h", { role: "toolResult", toolCallId: "g", toolName: "bash", content: [{ type: "text", text: "[main abc1234] fix: auth" }], isError: false }),
      long("i"),
    ], { keep: 0 });
    expect(c.details.historyIndex).toEqual([{
      from: 0, to: 8, requests: 2,
      asks: ["a much longer ask that carries the actual requirement"],
      files: ["src/auth/session.ts"], commits: ["abc1234 fix: auth"], commitCount: 1, failed: 1,
    }]);
  });

  // Seen with a real model: a 500-character first request and a 250-character second one
  // both clip to 80 characters, and the index quoted the second.
  it("quotes the longest request by its full length, not its clipped one", () => {
    const first = "Create a tiny inventory module in this empty directory: src/inventory.py with add_item(name, qty) that adds to an in-memory dict and total() that returns the sum of all quantities, plus tests/test_inventory.py with three plain assert checks you run with python3 (no pytest). Run the tests, then commit with git commit -q -m 'feat: inventory' and show git log --oneline -1. One more rule for the whole project: quantities are integers and never negative, so add_item must raise ValueError for a negative qty.";
    const second = "Rename total() to total_qty() in src/inventory.py and the tests, run the tests, then fold it into the last commit with git commit -a --amend --no-edit -q and show git log --oneline -1.";
    const c = compact([say("a", "user", first), long("b"), say("c", "user", second), long("d")], { keep: 0 });
    const [r] = c.details.historyIndex as HistoryRange[];
    expect(r.asks[0].startsWith("Create a tiny inventory module")).toBe(true);
    expect(r.asks.every((a) => a.length <= 80)).toBe(true);
  });
});

describe("the index across compactions", () => {
  it("stays at its line limit, covers the whole history, and keeps the newest range on its own", () => {
    const full = Array.from({ length: DEFAULT_SUMMARY_LIMITS.historyRanges }, (_, i) => range(i, i));
    // The ranges stored cover #0–#7; the ten entries behind the compaction go to #9.
    const index = compact([...behind(full.map((r, i) => (i === full.length - 1 ? { ...r, to: 9 } : r))), ...fresh()], { keep: 1 }).details.historyIndex as HistoryRange[];
    expect(index).toHaveLength(DEFAULT_SUMMARY_LIMITS.historyRanges);
    expect(index[0].from).toBe(0);
    expect(index.at(-1)).toMatchObject({ from: 10, to: 11 });
    for (let i = 1; i < index.length; i++) expect(index[i].from).toBe(index[i - 1].to + 1);
  });

  it("a merged range keeps the longest asks and adds up counts", () => {
    const full = Array.from({ length: DEFAULT_SUMMARY_LIMITS.historyRanges }, (_, i) =>
      range(i, i === DEFAULT_SUMMARY_LIMITS.historyRanges - 1 ? 9 : i, { asks: [i === 0 ? "the long constraint from the start" : "x"], failed: 1, commitCount: 1, commits: [`c${i}`] }));
    const index = compact([...behind(full), ...fresh()], { keep: 1 }).details.historyIndex as HistoryRange[];
    expect(index[0].asks[0]).toBe("the long constraint from the start");
    expect(index[0].failed).toBe(2);
    expect(index[0].commitCount).toBe(2);
  });

  // Seen with a real model: a compaction kept a turn's final reply, and the next one
  // summarized that reply alone, which rendered as an empty "#10–#10" line.
  it("a range that names nothing extends the one before it instead of adding a line", () => {
    const branch = [...behind([range(0, 9)]).slice(0, 10), { id: "k0", type: "compaction", firstKeptEntryId: "r", summary: "[user]\nold", details: { compactor: "keel", version: 2, historyIndex: [range(0, 9)] } },
      say("r", "assistant", "the reply that was kept"), say("u", "user", "next request"), long("v")];
    expect(compact(branch, { keep: 1 }).details.historyIndex).toEqual([{ ...range(0, 9), to: 10 }]);
  });

  it("reads keel details (and pre-rename pi-vcc ones), including omp's notes-backed wrapper, and rejects anything else", () => {
    const stored = [range(0, 9)];
    const first = (branch: any[]) => (compact(branch, { keep: 1 }).details.historyIndex as HistoryRange[])[0];
    expect(first([...behind(stored), ...fresh()])).toEqual(range(0, 9));
    expect(first([...behind(stored, "pi-vcc"), ...fresh()])).toEqual(range(0, 9));
    expect(first([...behind(stored, "omp-vcc"), ...fresh()])).toEqual(range(0, 9));
    expect(first([...behind(stored, "keel", true), ...fresh()])).toEqual(range(0, 9));
    // Another compactor's, or one malformed: the history behind it is not indexed.
    const unindexed = { from: 0, to: 9, asks: [], files: [], commits: [], commitCount: 0, failed: 0 };
    expect(first([...behind(stored, "other"), ...fresh()])).toEqual(unindexed);
    expect(first([...behind([{ from: "x" }]), ...fresh()])).toEqual(unindexed);
  });
});

describe("[History Index] lines", () => {
  const lines = (historyIndex: HistoryRange[]) => sectionLines(summarize({ messages: [{ role: "user", content: "hello there" }] }, { historyIndex }).text, "History Index");

  it("names a few files, and the directories of many", () => {
    expect(lines([range(0, 9, { files: ["src/auth/a.ts"] })])).toEqual(['#0–#9: 1 request: "ask 0" · changed auth/a.ts']);
    expect(lines([range(0, 9, { files: ["src/auth/a.ts", "src/auth/b.ts", "src/billing/c.ts", "lib/d.ts"] })])[0]).toContain("changed 4 files in auth, billing, lib");
  });

  it("counts commits a range does not list without inventing the last one", () => {
    expect(lines([range(0, 9, { commits: [], commitCount: 2 })])).toEqual(['#0–#9: 1 request: "ask 0" · 2 commits']);
  });

  it("marks history from before the index", () => {
    expect(lines([{ from: 0, to: 99, asks: [], files: [], commits: [], commitCount: 0, failed: 0 }])).toEqual(["#0–#99: earlier, not indexed; search it with keel_recall"]);
  });
});

describe("history index across compactions (the hook)", () => {
  let n = 0;
  const msg = (role: "user" | "assistant", text: string) => ({
    id: `m${++n}`, type: "message",
    message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
  });
  const turns = (k: number) => Array.from({ length: k }, (_, i) => [msg("user", `request number ${n} please`), msg("assistant", `done ${i}`)]).flat();

  it("carries the stored index forward and adds the new window", () => {
    const first = turns(3);
    const c1 = compact(first);
    expect(c1.details.historyIndex).toEqual([expect.objectContaining({ from: 0, to: 3, requests: 2 })]);
    expect(c1.summary).toContain("[History Index]\n- #0–#3: 2 requests");

    const second = [...first, { id: "k1", type: "compaction", firstKeptEntryId: c1.firstKeptEntryId, summary: c1.summary, details: c1.details }, ...turns(3)];
    const c2 = compact(second, { previousSummary: c1.summary });
    expect(c2.details.historyIndex.map((r: HistoryRange) => [r.from, r.to])).toEqual([[0, 3], [4, 9]]);
    expect(c2.summary.match(/\[History Index\]/g)).toHaveLength(1);
  });

  it("indexes history a compaction without an index left behind as one range", () => {
    const first = turns(2);
    const old = { id: "k0", type: "compaction", firstKeptEntryId: "", summary: "[user]\nold", details: { compactor: "keel", version: 2 } };
    const c = compact([...first, old, ...turns(3)], { previousSummary: "[user]\nold" });
    expect(c.details.historyIndex[0]).toEqual({ from: 0, to: 3, asks: [], files: [], commits: [], commitCount: 0, failed: 0 });
    expect(c.summary).toContain("#0–#3: earlier, not indexed");
  });

  it("after another compactor's summary, this window's requests are not the session's first ones", () => {
    const llm = "## Goal\nThe user is building a payments service.\n\n## Progress\n- Implemented the ledger.";
    const theirs = { id: "k0", type: "compaction", firstKeptEntryId: "", summary: llm, details: { readFiles: [] } };
    const c = compact([...turns(2), theirs, ...turns(3)], { previousSummary: llm });
    expect(c.summary).not.toContain("[Early Session Requests]");
    expect(c.summary).toContain("[User Messages]");
  });

  it("starts over after omp's /clear", () => {
    const first = turns(3);
    const c1 = compact(first);
    const later = [...first, { id: "k1", type: "compaction", firstKeptEntryId: c1.firstKeptEntryId, summary: c1.summary, details: c1.details },
      { id: "r", type: "reset_boundary" }, ...turns(3)];
    const c2 = compact(later);
    expect(c2.details.historyIndex.map((r: HistoryRange) => r.from)).toEqual([6]);
  });
});
