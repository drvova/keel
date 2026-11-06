// Session and tool shapes particular to Pi, through the hook on Pi's own
// convertToLlm: its message roles (a `!!` command Pi keeps out of context, a
// custom message, a branch summary, a system message in the transcript), its
// edit tool's `edits` list, and its agent dir. Runs where Pi is installed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertRealPi, piInstalled } from "./support/pi";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCompactionState, registerCompactionHook, type CompactionHost } from "../src/hooks/compaction";
import { buildOwnCut } from "../src/compaction/cut";
import { toSummaryMessage } from "../src/compaction/summary-input";
import { normalize } from "../src/core/normalize";
import { extractFiles } from "../src/extract/files";
import { getTouchedFiles } from "../src/core/search-entries";
import { fileWriteOf, writtenText } from "../src/core/tools";
import { setSettingsAgentDir, settingsPath } from "../src/core/settings";
import { PI_TRIGGER_RULE } from "../src/core/window";



describe.skipIf(!piInstalled())("Pi shapes", () => {
  let pi: any;
  let host: CompactionHost;
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    assertRealPi();
    pi = await import("@earendil-works/pi-coding-agent");
    host = { convertToLlm: (m) => pi.convertToLlm(m), rule: PI_TRIGGER_RULE };
    dir = mkdtempSync(join(tmpdir(), "omp-vcc-pi-shapes-"));
    for (const key of ["OMP_VCC_CONFIG_PATH", "PI_CODING_AGENT_DIR"]) saved[key] = process.env[key];
    process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false }));
  });

  afterAll(() => {
    setSettingsAgentDir();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const summaryOf = (message: any) => toSummaryMessage(message, host.convertToLlm);

  describe("Pi's message roles in the summary", () => {
    test("a user-run command stays one line; one run with !! (kept out of Pi's context) is left out", () => {
      const run = { role: "bashExecution", command: "bun test", output: "3 pass", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 };
      expect(summaryOf(run)).toBe(run);
      expect(summaryOf({ ...run, excludeFromContext: true })).toBeNull();
    });

    test("an extension's custom message reads as injected user content, a branch summary as user content", () => {
      expect(summaryOf({ role: "custom", customType: "note", content: "From the CI extension", display: true, timestamp: 1 }))
        .toMatchObject({ role: "user", injected: true, content: [{ type: "text", text: "From the CI extension" }] });
      const branch = summaryOf({ role: "branchSummary", summary: "Tried the queue approach, dropped it.", fromId: "x", timestamp: 1 });
      expect(branch.role).toBe("user");
      expect(JSON.stringify(branch.content)).toContain("Tried the queue approach, dropped it.");
    });

    test("a system message in the transcript renders nothing", () => {
      const system = summaryOf({ role: "system", content: "You are Pi.", timestamp: 1 });
      expect(normalize([system].filter(Boolean))).toEqual([]);
    });
  });

  describe("Pi's edit tool (path, edits: [{ oldText, newText }])", () => {
    const args = { path: "src/money.ts", edits: [{ oldText: "floor + 1 : floor", newText: "floor : floor + 1" }, { oldText: "a", newText: "b" }] };
    const edit: any = { role: "assistant", content: [{ type: "toolCall", id: "t", name: "edit", arguments: args }] };

    test("is a change: listed as modified, drillable in mode:'touched', its text searchable", () => {
      expect(fileWriteOf({ name: "edit", args })?.edits).toHaveLength(2);
      expect(writtenText(args)).toContain("floor : floor + 1");
      const files = extractFiles([{ kind: "tool_call", name: "edit", args } as any]);
      expect([...files.modified]).toEqual(["src/money.ts"]);
      const touched = getTouchedFiles([edit], [{ index: 4, role: "assistant", summary: "" }]);
      expect(touched[0]).toMatchObject({ path: "src/money.ts", entries: [{ index: 4, toolName: "edit" }] });
    });
  });

  describe("the hook on a Pi branch", () => {
    const entry = (id: string, message: any) => ({ id, type: "message", parentId: null, timestamp: "2026-11-06T00:00:00.000Z", message: { timestamp: 1, ...message } });
    const branch = () => [
      entry("u1", { role: "user", content: "Fix the rounding in src/money.ts" }),
      entry("a1", { role: "assistant", content: [{ type: "toolCall", id: "e", name: "edit", arguments: { path: "src/money.ts", edits: [{ oldText: "floor + 1", newText: "floor" }] } }] }),
      entry("t1", { role: "toolResult", toolCallId: "e", toolName: "edit", content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/money.ts." }], isError: false }),
      entry("b1", { role: "bashExecution", command: "bun test money", output: "1 pass", exitCode: 0, cancelled: false, truncated: false }),
      entry("b2", { role: "bashExecution", command: "cat ~/.secrets", output: "token", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true }),
      { id: "c1", type: "custom_message", parentId: null, timestamp: "2026-11-06T00:00:00.000Z", customType: "ci", content: "CI is green", display: true },
      entry("u2", { role: "user", content: "Now the changelog" }),
      entry("a2", { role: "assistant", content: [{ type: "text", text: "Added the entry." }] }),
    ];

    test("summarizes Pi's shapes as Pi's context holds them, sized for Pi's trigger", () => {
      const handlers = new Map<string, any>();
      const fake: any = { on: (name: string, h: any) => handlers.set(name, h) };
      registerCompactionHook(fake, { ...host, compactionTrigger: () => ({ reason: "threshold", willRetry: false }) }, createCompactionState());
      const result = handlers.get("session_before_compact")(
        {
          type: "session_before_compact",
          preparation: { tokensBefore: 5000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
          branchEntries: branch(),
          reason: "threshold",
          willRetry: false,
        },
        { model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 }, sessionManager: { getEntries: () => branch(), getBranch: () => branch() } },
      );
      const { summary, details } = result.compaction;
      expect(summary).toContain("- Modified: src/money.ts");
      expect(summary).toContain("$ bun test money");
      expect(summary).not.toContain("cat ~/.secrets");
      // [Early Session Requests] reads what the user wrote, not an extension's message.
      expect(summary).toContain("- Fix the rounding in src/money.ts");
      expect(summary).not.toMatch(/\[Early Session Requests\][^[]*CI is green/);
      expect(details).toMatchObject({ compactor: "omp-vcc", reason: "threshold" });
      expect(details.limits).toMatchObject({ windowSource: "pi", trigger: 183_616 });
    });

    test("a compact-all keeps nothing, which Pi reads from an empty firstKeptEntryId", () => {
      const cut = buildOwnCut(host.convertToLlm, branch(), 0, []);
      expect(cut.ok && cut.compactAll).toBe(true);
      // Pi's buildContextEntries keeps nothing before a compaction whose kept id is not on the path.
      const compaction = { type: "compaction", id: "cmp", parentId: "a2", timestamp: "2026-11-06T00:00:00.000Z", summary: "s", firstKeptEntryId: "", tokensBefore: 1 };
      let parent: string | null = null;
      const linked = [...branch(), compaction].map((e) => {
        const withParent = { ...e, parentId: parent };
        parent = e.id;
        return withParent;
      });
      expect(pi.buildContextEntries(linked, "cmp").map((e: any) => e.id)).toEqual(["cmp"]);
    });
  });

  test("the settings follow Pi's agent dir", () => {
    delete process.env.OMP_VCC_CONFIG_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    setSettingsAgentDir(pi.getAgentDir);
    expect(settingsPath()).toBe(join(pi.getAgentDir(), "omp-vcc-config.json"));
    expect(settingsPath()).toContain(join(".pi", "agent"));
    process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
  });
});
