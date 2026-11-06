import { describe, it, expect } from "bun:test";
import { textParts, textOf } from "../src/core/content";
import { argsText } from "../src/core/tools";

describe("textParts", () => {
  it("returns [] for missing content", () => {
    expect(textParts(undefined as any)).toEqual([]);
    expect(textParts(null as any)).toEqual([]);
  });

  it("wraps string content", () => {
    expect(textParts("hello")).toEqual(["hello"]);
  });

  it("extracts text parts from array content", () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "toolCall" as const, name: "x", id: "1", arguments: {} },
      { type: "text" as const, text: "second" },
    ];
    expect(textParts(content)).toEqual(["first", "second"]);
  });
});

describe("textOf", () => {
  it("returns empty string for undefined content", () => {
    expect(textOf(undefined as any)).toBe("");
  });
});

describe("argsText", () => {
  it("extracts top-level string scalars (e.g. bash command)", () => {
    expect(argsText({ command: "grep -rn foo src" })).toBe("grep -rn foo src");
  });

  it("extracts strings from array-of-object fields (e.g. edits[])", () => {
    const args = { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] };
    const text = argsText(args);
    expect(text).toContain("a.ts");
    expect(text).toContain("old");
    expect(text).toContain("new");
  });

  it("ignores non-string scalars (numbers/booleans)", () => {
    expect(argsText({ limit: 50, verbose: true })).toBe("");
  });

  it("does not clip on its own — extraction is unbounded; the caller (search-entries.ts) owns the budget", () => {
    const text = argsText({ content: "x".repeat(10_000) });
    expect(text.length).toBe(10_000);
  });
});
