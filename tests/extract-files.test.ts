import { afterEach, describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFiles } from "../src/extract/files";
import { DEFAULT_SETTINGS, loadSettings } from "../src/core/settings";
import type { NormalizedBlock } from "../src/types";

describe("extractFiles", () => {
  it("matches tool names case-insensitively", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "read", args: { path: "a.ts" } },
      { kind: "tool_call", name: "Read", args: { path: "b.ts" } },
      { kind: "tool_call", name: "Write", args: { path: "c.ts" } },
      { kind: "tool_call", name: "MultiEdit", args: { path: "d.ts" } },
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
    const r = extractFiles(blocks, { writtenFiles: ["src/money.py", "README.md", "gen/out.txt"], modifiedFiles: ["src/money.py"] });
    expect([...r.created]).toEqual(["src/money.py", "notes.md"]);
    expect([...r.modified]).toEqual(["README.md", "gen/out.txt"]);
  });

  it("leaves omp's artifact:// store and other URLs out of the file lists", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "read", args: { path: "src/money.py" } },
      { kind: "tool_call", name: "read", args: { path: "artifact://0" } },
    ];
    const r = extractFiles(blocks, { readFiles: ["artifact://0", "skill://x/SKILL.md"] });
    expect([...r.read]).toEqual(["src/money.py"]);
  });

  it("records modern edit tools as modifications", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "quick_edit", args: { path: "a.ts" } },
      { kind: "tool_call", name: "target_edit", args: { path: "b.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.modified].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("records every path of a multi-path edit tool", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "edit", args: { code: "...", paths: ["a.ts", "b.ts", 3, ""], lang: "node" } },
    ];
    expect([...extractFiles(blocks).modified].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("seeds activity from hook-provided fileOps", () => {
    const r = extractFiles([], { readFiles: ["x.ts"], modifiedFiles: ["y.ts"], createdFiles: [] });
    expect([...r.read]).toEqual(["x.ts"]);
    expect([...r.modified]).toEqual(["y.ts"]);
  });
});

describe("settings defaults", () => {
  it("overrides pi core compaction by default", () => {
    expect(DEFAULT_SETTINGS.overrideDefaultCompaction).toBe(true);
  });

  it("trackCommands is empty (feature off) by default", () => {
    expect(DEFAULT_SETTINGS.trackCommands).toEqual([]);
  });
});

describe("loadSettings coercion", () => {
  // OMP_VCC_CONFIG_PATH is settings.ts' existing override — point it at a
  // tmp file so the real ~/.omp/agent/omp-vcc-config.json is never touched.
  const writeConfig = (value: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ trackCommands: value }));
    process.env.OMP_VCC_CONFIG_PATH = path;
  };

  afterEach(() => delete process.env.OMP_VCC_CONFIG_PATH);

  it("malformed trackCommands values coerce fail-closed to string[]", () => {
    for (const bad of ["ssh", 42, [1, " kubectl ", null, "kubectl"], null, { 0: "ssh" }]) {
      writeConfig(bad);
      const got = loadSettings().trackCommands;
      expect(Array.isArray(got)).toBe(true);
      for (const x of got) expect(typeof x).toBe("string");
    }
    writeConfig(["ssh", "kubectl"]);
    expect(loadSettings().trackCommands).toEqual(["ssh", "kubectl"]);
  });
});
