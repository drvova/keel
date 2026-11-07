import { describe, it, expect } from "bun:test";
import type { NormalizedBlock } from "./support/compile";
import type { FileOps } from "./support/compile";
import { summarize, UNCAPPED } from "./support/summary";

/** The files the summary of these blocks lists, as it stores them for the next compaction. */
const extractFiles = (blocks: NormalizedBlock[], fileOps?: FileOps) => summarize(blocks, { limits: UNCAPPED, ...(fileOps ? { fileOps } : {}) }).state.files;

describe("extractFiles", () => {
  it("matches tool names case-insensitively", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "read", args: { path: "a.ts" } },
      { kind: "tool_call", name: "Read", args: { path: "b.ts" } },
      { kind: "tool_call", name: "Write", args: { path: "c.ts" } },
      { kind: "tool_call", name: "Edit", args: { path: "d.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.read].sort()).toEqual(["a.ts", "b.ts"]);
    expect([...r.modified]).toEqual(["d.ts"]);
    expect([...r.created]).toEqual(["c.ts"]);
  });

  // Seen with a real model: files the agent wrote new were all listed as Modified,
  // so [Files And Changes] never said which files the session created.
  it("a write to a path not touched before here creates it; after a read or edit it rewrites it", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "write", args: { path: "src/money.py" } },
      { kind: "tool_call", name: "edit", args: { path: "src/money.py" } },
      { kind: "tool_call", name: "read", args: { path: "README.md" } },
      { kind: "tool_call", name: "write", args: { path: "README.md" } },
      { kind: "tool_call", name: "read", args: { path: "notes.md" }, failed: true },
      { kind: "tool_call", name: "write", args: { path: "notes.md" } },
      { kind: "tool_call", name: "write", args: { path: "broken.md" }, failed: true },
    ];
    const r = extractFiles(blocks, { changed: ["src/money.py", "README.md", "gen/out.txt", "src/money.py"] });
    expect([...r.created]).toEqual(["src/money.py", "notes.md"]);
    expect([...r.modified]).toEqual(["README.md", "gen/out.txt"]);
  });

  it("leaves omp's artifact:// store and other URLs out of the file lists", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "read", args: { path: "src/money.py" } },
      { kind: "tool_call", name: "read", args: { path: "artifact://0" } },
    ];
    const r = extractFiles(blocks, { read: ["artifact://0", "skill://x/SKILL.md"] });
    expect([...r.read]).toEqual(["src/money.py"]);
  });

  it("records omp's ast_edit, and another extension's tool by its edit arguments, as modifications", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "ast_edit", args: { ops: [{ pat: "a", out: "b" }], paths: ["c.ts"] } },
      { kind: "tool_call", name: "quick_edit", args: { path: "a.ts", old_string: "x", new_string: "y" } },
      { kind: "tool_call", name: "target_edit", args: { path: "b.ts", edits: [{ oldText: "x", newText: "y" }] } },
      { kind: "tool_call", name: "lookup", args: { path: "d.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.modified].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect([...r.read]).toEqual([]);
  });

  it("records every path of a multi-path edit tool", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "edit", args: { code: "...", paths: ["a.ts", "b.ts", 3, ""], lang: "node" } },
    ];
    expect([...extractFiles(blocks).modified].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("a write or edit that failed changed nothing, though the host's list names it", () => {
    const failed = (name: string, args: Record<string, unknown>): NormalizedBlock => ({ kind: "tool_call", name, args, failed: true });
    const r = extractFiles([failed("edit", { path: "a.ts", oldText: "x", newText: "y" }), failed("write", { path: "b.ts", content: "z" })], { changed: ["a.ts", "b.ts", "c.ts"] });
    // c.ts is a call the blocks do not show: the host's word stands.
    expect([...r.modified]).toEqual(["c.ts"]);
    expect([...r.created]).toEqual([]);
  });

  it("seeds activity from hook-provided fileOps", () => {
    const r = extractFiles([], { read: ["x.ts"], changed: ["y.ts"] });
    expect([...r.read]).toEqual(["x.ts"]);
    expect([...r.modified]).toEqual(["y.ts"]);
  });
});
