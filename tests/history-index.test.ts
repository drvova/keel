import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatHistoryRange,
  MAX_RANGES,
  mergeHistoryIndex,
  rangeOfWindow,
  readHistoryIndex,
  type HistoryRange,
} from "../src/core/history-index";
import { registerHook } from "./support/host";

const range = (from: number, to: number, extra: Partial<HistoryRange> = {}): HistoryRange =>
  ({ from, to, requests: 1, asks: [`ask ${from}`], files: [], commits: [], commitCount: 0, failed: 0, ...extra });

describe("rangeOfWindow", () => {
  it("records the range, requests, longest asks, changed files, commits and failed calls", () => {
    const r = rangeOfWindow([
      { role: "user", content: "short ask here" },
      { role: "user", content: "a much longer ask that carries the actual requirement" },
      { role: "assistant", content: [{ type: "toolCall", id: "e", name: "edit", arguments: { path: "src/auth/session.ts", oldText: "a", newText: "b" } }] },
      { role: "toolResult", toolCallId: "e", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false },
      { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "bun test" } }] },
      { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "1 fail" }], isError: true },
      { role: "assistant", content: [{ type: "toolCall", id: "g", name: "bash", arguments: { command: 'git commit -m "fix: auth"' } }] },
      { role: "toolResult", toolCallId: "g", toolName: "bash", content: [{ type: "text", text: "[main abc1234] fix: auth" }], isError: false },
    ] as any, [40, 41, 42, 43, 44, 45, 46, 47]);
    expect(r).toEqual({
      from: 40, to: 47, requests: 2,
      asks: ["a much longer ask that carries the actual requirement", "short ask here"],
      files: ["src/auth/session.ts"], commits: ["abc1234 fix: auth"], commitCount: 1, failed: 1,
    });
  });

  it("has nothing to say without #N refs", () => {
    expect(rangeOfWindow([{ role: "user", content: "hello there" }] as any, [undefined])).toBeUndefined();
  });
});

describe("mergeHistoryIndex", () => {
  it("stays at MAX_RANGES, covers the whole history, and keeps the newest range on its own", () => {
    let index: HistoryRange[] = [];
    for (let i = 0; i < 40; i++) index = mergeHistoryIndex(index, range(i * 10, i * 10 + 9));
    expect(index).toHaveLength(MAX_RANGES);
    expect(index[0].from).toBe(0);
    expect(index.at(-1)).toMatchObject({ from: 390, to: 399 });
    for (let i = 1; i < index.length; i++) expect(index[i].from).toBe(index[i - 1].to + 1);
    expect(index.reduce((n, r) => n + (r.requests ?? 0), 0)).toBe(40);
  });

  it("a merged range keeps the longest asks and adds up counts", () => {
    const merged = mergeHistoryIndex(
      Array.from({ length: MAX_RANGES }, (_, i) => range(i * 10, i * 10 + 9, { asks: [i === 0 ? "the long constraint from the start" : "x"], failed: 1, commitCount: 1, commits: [`c${i}`] })),
      range(80, 89),
    );
    expect(merged[0].asks[0]).toBe("the long constraint from the start");
    expect(merged[0].failed).toBe(2);
    expect(merged[0].commitCount).toBe(2);
  });
});

describe("formatHistoryRange", () => {
  it("names a few files, and the directories of many", () => {
    expect(formatHistoryRange(range(0, 9, { files: ["src/auth/a.ts"] }))).toBe('#0–#9: 1 request: "ask 0" · changed auth/a.ts');
    const many = range(0, 9, { files: ["src/auth/a.ts", "src/auth/b.ts", "src/billing/c.ts", "lib/d.ts"] });
    expect(formatHistoryRange(many)).toContain("changed 4 files in auth, billing, lib");
  });

  it("marks history from before the index", () => {
    expect(formatHistoryRange({ from: 0, to: 99, asks: [], files: [], commits: [], commitCount: 0, failed: 0 }))
      .toBe("#0–#99: earlier, not indexed; search it with vcc_recall");
  });
});

describe("readHistoryIndex", () => {
  it("reads omp-vcc details (and pre-rename pi-vcc ones), including omp's notes-backed wrapper, and rejects anything else", () => {
    const historyIndex = [range(0, 9)];
    expect(readHistoryIndex({ compactor: "omp-vcc", historyIndex })).toEqual(historyIndex);
    expect(readHistoryIndex({ compactor: "pi-vcc", historyIndex })).toEqual(historyIndex);
    expect(readHistoryIndex({ kind: "experimental-context-rollover", hookDetails: { compactor: "omp-vcc", historyIndex } })).toEqual(historyIndex);
    expect(readHistoryIndex({ compactor: "other", historyIndex })).toBeUndefined();
    expect(readHistoryIndex({ compactor: "omp-vcc", historyIndex: [{ from: "x" }] })).toBeUndefined();
  });
});

describe("history index across compactions (the hook)", () => {
  let dir: string;
  const prev = process.env.OMP_VCC_CONFIG_PATH;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-vcc-index-"));
    process.env.OMP_VCC_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false }));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
    else process.env.OMP_VCC_CONFIG_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  let n = 0;
  const msg = (role: "user" | "assistant", text: string) => ({
    id: `m${++n}`, type: "message",
    message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
  });
  const turns = (k: number) => Array.from({ length: k }, (_, i) => [msg("user", `request number ${n} please`), msg("assistant", `done ${i}`)]).flat();

  const compact = (branchEntries: any[], previousSummary?: string) => {
    let handler: any;
    const hook = registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    hook.autoCompactionStart("threshold");
    return handler({
      type: "session_before_compact", branchEntries, customInstructions: undefined,
      preparation: { previousSummary, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} }, sessionManager: { getEntries: () => branchEntries } }).compaction;
  };

  it("carries the stored index forward and adds the new window", () => {
    const first = turns(3);
    const c1 = compact(first);
    expect(c1.details.historyIndex).toEqual([expect.objectContaining({ from: 0, to: 3, requests: 2 })]);
    expect(c1.summary).toContain("[History Index]\n- #0–#3: 2 requests");

    const second = [...first, { id: "k1", type: "compaction", firstKeptEntryId: c1.firstKeptEntryId, summary: c1.summary, details: c1.details }, ...turns(3)];
    const c2 = compact(second, c1.summary);
    expect(c2.details.historyIndex.map((r: HistoryRange) => [r.from, r.to])).toEqual([[0, 3], [4, 9]]);
    expect(c2.summary.match(/\[History Index\]/g)).toHaveLength(1);
  });

  it("indexes history a compaction without an index left behind as one range", () => {
    const first = turns(2);
    const old = { id: "k0", type: "compaction", firstKeptEntryId: "", summary: "[user]\nold", details: { compactor: "omp-vcc", version: 2 } };
    const c = compact([...first, old, ...turns(3)], "[user]\nold");
    expect(c.details.historyIndex[0]).toEqual({ from: 0, to: 3, asks: [], files: [], commits: [], commitCount: 0, failed: 0 });
    expect(c.summary).toContain("#0–#3: earlier, not indexed");
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
