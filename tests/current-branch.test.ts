import { describe, it, expect } from "bun:test";
import { currentBranchIds } from "../src/core/session-file";

describe("currentBranchIds", () => {
  it("returns IDs from active branch", () => {
    const ids = currentBranchIds({
      getBranch: () => [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    expect([...ids]).toEqual(["a", "b", "c"]);
  });

  it("falls back to getEntries when getBranch throws", () => {
    const ids = currentBranchIds({
      getBranch: () => {
        throw new Error("boom");
      },
      getEntries: () => [{ id: "x" }, { id: "y" }],
    });
    expect([...ids]).toEqual(["x", "y"]);
  });

  it("returns empty set when both branch and entries are unavailable", () => {
    const ids = currentBranchIds({
      getBranch: () => {
        throw new Error("boom");
      },
      getEntries: () => {
        throw new Error("boom2");
      },
    });
    expect(ids.size).toBe(0);
  });
});
