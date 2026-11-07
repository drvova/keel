import { callRecallTool, recallTool } from "./support/binding";
import { sessionFileOfEntries } from "./support/session-files";
import { describe, it, expect } from "bun:test";
import { rmSync } from "fs";

const makeSession = () => sessionFileOfEntries([
  { type: "message", id: "m1", message: { role: "user", content: `active lineage token ${"x".repeat(350)} full-content-end` } },
  { type: "message", id: "m2", message: { role: "user", content: "off lineage secret" } },
]);

const register = recallTool;
// The path holds m1; m2 is on another branch.
const invoke = (tool: any, file: string, params: Record<string, unknown>) => callRecallTool(tool, file, params, ["m1", "m2"], ["m1"]);

describe("vcc_recall scope", () => {
  it("defaults to active lineage, falls back to other branches with a note, and opts into all explicitly", async () => {
    const { dir, file } = makeSession();
    try {
      const tool = register();

      const onPath = await invoke(tool, file, { query: "active" });
      expect(onPath).not.toContain("off lineage secret");
      expect(onPath).not.toContain("current conversation path");

      const lineage = await invoke(tool, file, { query: "secret" });
      expect(lineage.startsWith("Nothing on the current conversation path; showing edited or retried branches (scope:'all').")).toBe(true);
      expect(lineage).toContain("off lineage secret");

      const all = await invoke(tool, file, { query: "secret", scope: "all" });
      expect(all).toContain("scope: all");
      expect(all).toContain("off lineage secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands full entries even when the original query is included", async () => {
    const { dir, file } = makeSession();
    try {
      const tool = register();
      const output = await invoke(tool, file, { query: "active", expand: [0] });

      expect(output).toContain("#0 [user]");
      expect(output).toContain("full-content-end");
      expect(output).not.toContain("matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands an off-lineage entry with a note by default, and plainly with scope all", async () => {
    const { dir, file } = makeSession();
    try {
      const tool = register();

      const lineage = await invoke(tool, file, { expand: [1] });
      expect(lineage).toContain("#1 is not on the current conversation path (edited or retried branch).");
      expect(lineage).toContain("#1 [user] off lineage secret");

      const missing = await invoke(tool, file, { expand: [7] });
      expect(missing).toBe("Cannot expand indices outside session history: 7");

      const all = await invoke(tool, file, { expand: [1], scope: "all" });
      expect(all).toContain("Scope: all");
      expect(all).toContain("#1 [user] off lineage secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
