import { describe, it, expect } from "bun:test";
import { filterNoise } from "../src/core/filter-noise";
import type { NormalizedBlock } from "../src/types";

describe("filterNoise", () => {
  it("removes user blocks that are pure XML wrappers", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>some noise</system-reminder>" },
      { kind: "user", text: "Fix the bug" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "user", text: "Fix the bug" });
  });

  it("cleans XML wrappers from user text but keeps real content", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>noise</system-reminder>\nFix the login" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).text).toBe("Fix the login");
  });

  it("removes known noise strings", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Continue from where you left off." },
      { kind: "user", text: "real task" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).text).toBe("real task");
  });

  it("preserves non-noise tool calls", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Edit", args: { path: "a.ts" } },
      { kind: "tool_result", name: "Edit", text: "ok" },
    ];
    expect(filterNoise(blocks)).toHaveLength(2);
  });

  it("keeps the injected flag on cleaned user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>x</system-reminder>relayed note", injected: true },
    ];
    expect(filterNoise(blocks)).toEqual([{ kind: "user", text: "relayed note", injected: true }]);
  });
});
