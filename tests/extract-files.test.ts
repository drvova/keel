import { describe, it, expect } from "bun:test";
import { extractFiles } from "../src/extract/files";
import type { NormalizedBlock } from "../src/types";

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

  it("seeds activity from hook-provided fileOps", () => {
    const r = extractFiles([], { read: ["x.ts"], changed: ["y.ts"] });
    expect([...r.read]).toEqual(["x.ts"]);
    expect([...r.modified]).toEqual(["y.ts"]);
  });
});
