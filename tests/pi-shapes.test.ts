// Session and tool shapes particular to Pi, through the hook on Pi's own
// convertToLlm: its message roles (a `!!` command Pi keeps out of context, a
// custom message, a branch summary, a system message in the transcript), its
// edit tool's `edits` list, and its agent dir. Runs where Pi is installed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertRealPi, piInstalled } from "./support/pi";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCompactionState, registerCompaction } from "../src/compaction";
import { testConfig } from "./support/binding";
import { core } from "../src/core";
import { summarize } from "./support/summary";
import { COMPACT_INSTRUCTION } from "./support/names";
import { recallOn } from "./support/pairs";
import { openConfig } from "../src/settings";
import { MANUAL_TRIGGER, PI_HOST, type Binding } from "../src/host";



describe.skipIf(!piInstalled())("Pi shapes", () => {
  let pi: any;
  let host: Binding;
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    assertRealPi();
    pi = await import("@earendil-works/pi-coding-agent");
    host = { ...PI_HOST, convertToLlm: (m: any[]) => pi.convertToLlm(m), agentDir: () => "", triggerOf: () => MANUAL_TRIGGER, config: testConfig };
    dir = mkdtempSync(join(tmpdir(), "keel-pi-shapes-"));
    for (const key of ["KEEL_CONFIG_PATH", "PI_CODING_AGENT_DIR"]) saved[key] = process.env[key];
    process.env.KEEL_CONFIG_PATH = join(dir, "keel-config.json");
    writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false, evict: false }));
    // Importing Pi takes seconds on a loaded machine, past bun's 5 s for a hook.
  }, 30_000);

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** The summary /keel keep:0 writes of a branch with these entries, on Pi's convertToLlm. */
  const summaryOf = (...entries: any[]): string => {
    const at = (i: number) => ({ id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: "2026-11-06T00:00:00.000Z" });
    const branch = [
      { type: "message", ...at(0), message: { role: "user", content: "Look at the build", timestamp: 1 } },
      ...entries.map((e, i) => ({ ...at(i + 1), ...e })),
      // A long reply, so summarizing shrinks the context and the growth guard lets it be written.
      { type: "message", ...at(entries.length + 1), message: { role: "assistant", content: [{ type: "text", text: "Done. ".repeat(400) }], timestamp: 1 } },
    ];
    const handlers = new Map<string, any>();
    registerCompaction({ on: (name: string, h: any) => handlers.set(name, h), registerCommand: () => {} } as any, host, createCompactionState());
    return handlers.get("session_before_compact")(
      { type: "session_before_compact", customInstructions: `${COMPACT_INSTRUCTION} keep:0`, branchEntries: branch,
        preparation: { tokensBefore: 5000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16_384 } } },
      { sessionManager: { getEntries: () => branch, getBranch: () => branch } },
    ).compaction.summary;
  };
  const message = (m: any) => ({ type: "message", message: { timestamp: 1, ...m } });

  describe("Pi's message roles in the summary", () => {
    test("a user-run command stays one line; one run with !! (kept out of Pi's context) is left out", () => {
      const run = { role: "bashExecution", command: "bun test --watch-not", output: "3 pass", exitCode: 0, cancelled: false, truncated: false };
      expect(summaryOf(message(run))).toContain("$ bun test --watch-not");
      expect(summaryOf(message({ ...run, excludeFromContext: true }))).not.toContain("bun test --watch-not");
    });

    test("an extension's custom message reads as injected user content, a branch summary as user content", () => {
      const summary = summaryOf(
        { type: "custom_message", customType: "note", content: "From the CI extension", display: true },
        { type: "branch_summary", summary: "Tried the queue approach, dropped it.", fromId: "x" },
      );
      expect(summary).toContain("From the CI extension");
      expect(summary).toContain("Tried the queue approach, dropped it.");
      // Injected: not a request the user wrote.
      expect(summary).not.toMatch(/\[Early Session Requests\][^[]*From the CI extension/);
    });

    test("a system message in the transcript renders nothing", () => {
      expect(summaryOf(message({ role: "system", content: "You are Pi, a system prompt." }))).not.toContain("You are Pi");
    });
  });

  describe("Pi's edit tool (path, edits: [{ oldText, newText }])", () => {
    const args = { path: "src/money.ts", edits: [{ oldText: "floor + 1 : floor", newText: "floor : floor + 1" }, { oldText: "a", newText: "b" }] };
    const edit: any = { role: "assistant", content: [{ type: "toolCall", id: "t", name: "edit", arguments: args }] };

    test("is a change: listed as modified, drillable in mode:'touched'", () => {
      expect(summarize([{ kind: "tool_call", name: "edit", args } as any]).state.files.modified).toEqual(["src/money.ts"]);
      const touched = recallOn([edit], { mode: "touched" });
      expect(touched).toContain("  src/money.ts    #0 (edit)");
      expect(touched).toContain("query:'#0:money.ts'");
      // Both of its edits are what it put in the file.
      const content = recallOn([edit], { query: "#0:src/money.ts" });
      expect(content).toContain("floor : floor + 1");
      expect(content).toContain("b");
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
      const fake: any = { on: (name: string, h: any) => handlers.set(name, h), registerCommand: () => {} };
      registerCompaction(fake, { ...host, triggerOf: () => ({ reason: "threshold", willRetry: false }) }, createCompactionState());
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
      expect(details).toMatchObject({ compactor: "keel", reason: "threshold" });
      expect(details.limits).toMatchObject({ windowSource: "pi", trigger: 183_616 });
    });

    test("a compact-all keeps nothing, which Pi reads from an empty firstKeptEntryId", () => {
      // The core's cut (op cut) at keep:0, on Pi's convertToLlm.
      const ask = (converted?: unknown[][]) => core({ op: "cut", action: "own", keep: 0, skip: [], branchEntries: branch(), ...(converted ? { converted } : {}) });
      const first = ask();
      const cut = (first.kind === "convert" ? ask((first.messages as unknown[]).map((m) => { try { return host.convertToLlm([m]); } catch { return []; } })) : first).cut as any;
      expect(cut.ok && cut.compactAll).toBe(true);
      if (!cut.ok) return;
      // Pi's buildContextEntries keeps nothing before a compaction whose kept id is not on the path.
      const compaction = { type: "compaction", id: "cmp", parentId: "a2", timestamp: "2026-11-06T00:00:00.000Z", summary: "s", firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: 1 };
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
    delete process.env.KEEL_CONFIG_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    const config = openConfig(pi.getAgentDir);
    expect(config.path()).toBe(join(pi.getAgentDir(), "keel-config.json"));
    expect(config.path()).toContain(join(".pi", "agent"));
    process.env.KEEL_CONFIG_PATH = join(dir, "keel-config.json");
  });
});
