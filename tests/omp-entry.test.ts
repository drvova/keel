// The omp entry (index.ts) against a fake omp extension API that hands it omp's
// real convertToLlm. tests/omp-host.test.ts runs the same entry inside a real omp.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import registerOmp from "../index";
import { ompConvertToLlm } from "./support/host";
import { OMP_VCC_COMPACT_INSTRUCTION } from "../src/core/compact-args";
import { setSettingsAgentDir } from "../src/core/settings";

let dir: string;
let previousConfig: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-omp-entry-"));
  previousConfig = process.env.OMP_VCC_CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
});

afterAll(() => {
  setSettingsAgentDir();
  if (previousConfig === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = previousConfig;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false }));
});

function createOmp(mode: "tui" | "rpc" = "rpc") {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools: any[] = [];
  const notices: Array<{ msg: string; level?: string }> = [];
  const userMessages: string[] = [];
  const customMessages: any[] = [];
  const compactCalls: unknown[] = [];
  let entries: any[] = [];
  let compactImpl: (arg: unknown) => Promise<void> = async () => {};

  const fire = (name: string, event: any) => {
    let result: any;
    for (const h of handlers.get(name) ?? []) {
      const r = h({ type: name, ...event }, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  };

  const ctx: any = {
    mode,
    ui: { notify: (msg: string, level?: string) => notices.push({ msg, level }) },
    model: { provider: "anthropic" },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionFile: () => undefined,
    },
    compact: async (arg: unknown) => {
      compactCalls.push(arg);
      await compactImpl(arg);
    },
  };

  const pi: any = {
    on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (name: string, c: any) => commands.set(name, c.handler),
    registerTool: (t: any) => tools.push(t),
    sendMessage: (m: any, o: any) => customMessages.push({ m, o }),
    sendUserMessage: (c: string) => userMessages.push(c),
    pi: { convertToLlm: ompConvertToLlm, getAgentDir: () => dir },
  };
  registerOmp(pi);

  const beforeCompact = (customInstructions?: string) =>
    fire("session_before_compact", {
      preparation: { previousSummary: undefined, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, tokensBefore: 5000 },
      branchEntries: entries,
      customInstructions,
      signal: new AbortController().signal,
    });

  return {
    handlers, commands, tools, notices, userMessages, customMessages, compactCalls, ctx, fire, beforeCompact,
    setEntries: (e: any[]) => { entries = e; },
    setCompact: (impl: (arg: unknown) => Promise<void>) => { compactImpl = impl; },
    run: (name: string, args = "") => commands.get(name)!(args, ctx),
  };
}

let n = 0;
const entry = (message: any) => ({ id: `e${++n}`, type: "message", message: { timestamp: 0, ...message } });
const user = (t: string, extra: Record<string, unknown> = {}) => entry({ role: "user", content: t, ...extra });
const assistant = (t: string) => entry({ role: "assistant", content: [{ type: "text", text: t }] });
const conversation = () => [
  user("First request: fix the login bug"),
  assistant("Looking into it."),
  user("Second request: also fix logout"),
  assistant("Both fixed."),
  user("Third request: write tests"),
  assistant("Tests written."),
];

describe("omp entry: registration", () => {
  test("registers the hook, the commands and tools, and no continue machinery", () => {
    const omp = createOmp();
    expect([...omp.handlers.keys()].sort()).toEqual(
      ["auto_compaction_end", "auto_compaction_start", "session_before_compact", "session_compact"],
    );
    expect([...omp.commands.keys()].sort()).toEqual(["omp-vcc", "omp-vcc-pin", "omp-vcc-recall", "omp-vcc-unpin"]);
    expect(omp.tools.map((t: any) => t.name)).toEqual(["vcc_recall", "vcc_pin"]);
  });

  test("vcc_recall is a top-level read-only tool with a plain JSON Schema", () => {
    const [tool] = createOmp().tools;
    expect(tool.name).toBe("vcc_recall");
    expect(tool.loadMode).toBe("essential");
    expect(tool.approval).toBe("read");
    expect(tool.parameters.type).toBe("object");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["expand", "mode", "page", "query", "range", "scope", "session"]);
    expect(Object.getOwnPropertySymbols(tool.parameters)).toEqual([]);
  });

  test("vcc_recall repairs its own arguments, since omp has no prepareArguments", async () => {
    const [tool] = createOmp().tools;
    const sessionManager = { getSessionFile: () => join(dir, "missing.jsonl"), getBranch: () => [] };
    const result = await tool.execute("t", { expand: "#3", bogus: 1 }, undefined, undefined, { sessionManager });
    expect(result.content[0].text).toContain("bogus");
  });
});

describe("omp entry: /omp-vcc", () => {
  test("passes callbacks to ctx.compact and the marker to the hook through state", async () => {
    const omp = createOmp();
    const entries = conversation();
    omp.setEntries(entries);
    let hookResult: any;
    omp.setCompact(async (arg: any) => {
      // omp runs the hook inside ctx.compact(), with no customInstructions.
      hookResult = omp.beforeCompact(undefined);
      omp.fire("session_compact", { compactionEntry: { details: hookResult.compaction.details }, fromExtension: true });
      arg.onComplete();
    });

    await omp.run("omp-vcc", "keep:2");

    expect(typeof omp.compactCalls[0]).toBe("object");
    expect(hookResult.compaction.details.compactor).toBe("omp-vcc");
    // keep:2 reached the hook: the tail starts at the second user turn.
    expect(hookResult.compaction.firstKeptEntryId).toBe(entries[2].id);
    await Bun.sleep(600);
    expect(omp.notices.some((x) => x.msg.startsWith("omp-vcc: kept 2/3 turns"))).toBe(true);
    // The marker is only for the pass the command started.
    expect(omp.beforeCompact(undefined)?.compaction.details.reason).toBe("manual");
  });

  test("a follow-up prompt is sent after the compaction, and replaces omp's resume", async () => {
    const omp = createOmp();
    omp.setEntries(conversation());
    omp.setCompact(async (arg: any) => {
      omp.beforeCompact(undefined);
      arg.onComplete();
    });
    await omp.run("omp-vcc", "keep:1 carry on");
    expect((omp.compactCalls[0] as any).suppressContinuation).toBe(true);
    expect(omp.userMessages).toEqual(["carry on"]);
  });

  test("print/RPC: a failure is reported, with omp's setting named for a short session", async () => {
    const omp = createOmp("rpc");
    omp.setCompact(async (arg: any) => {
      const err = new Error("Nothing to compact (session too small)");
      arg.onError(err);
      throw err;
    });
    await omp.run("omp-vcc");
    expect(omp.notices).toHaveLength(1);
    expect(omp.notices[0].msg).toContain("compaction.keepRecentTokens in omp settings");
  });

  test("TUI: omp shows the failure itself, so omp-vcc adds nothing for a generic error", async () => {
    const omp = createOmp("tui");
    omp.setCompact(async (arg: any) => {
      arg.onError(new Error("Compaction cancelled"));
    });
    await omp.run("omp-vcc");
    expect(omp.notices).toEqual([]);
  });
});

describe("omp entry: automatic compactions", () => {
  test("the trigger comes from auto_compaction_start and is used once", () => {
    const omp = createOmp();
    omp.setEntries(conversation());
    omp.fire("auto_compaction_start", { reason: "threshold", action: "context-full" });
    expect(omp.beforeCompact().compaction.details).toMatchObject({ reason: "threshold", willRetry: false });
    expect(omp.beforeCompact().compaction.details).toMatchObject({ reason: "manual", willRetry: false });
  });

  test("overflow recovery falls back to omp's own method when omp-vcc cannot cut", () => {
    const omp = createOmp();
    omp.setEntries([user("only one message")]);
    omp.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
    expect(omp.beforeCompact()).toBeUndefined();
    // A manual pass in the same state is cancelled instead.
    expect(omp.beforeCompact()).toEqual({ cancel: true });
  });

  test("no continue of its own after a threshold compaction: omp resumes by itself", async () => {
    const omp = createOmp();
    omp.setEntries(conversation());
    omp.fire("auto_compaction_start", { reason: "threshold", action: "context-full" });
    const result = omp.beforeCompact();
    await omp.fire("session_compact", { compactionEntry: { details: result.compaction.details }, fromExtension: true });
    await Bun.sleep(20);
    expect(omp.customMessages).toEqual([]);
    expect(omp.userMessages).toEqual([]);
  });
});

describe("omp entry: what the summary reads", () => {
  const summarize = (entries: any[]) => {
    const omp = createOmp();
    omp.setEntries(entries);
    return omp.beforeCompact(`${OMP_VCC_COMPACT_INSTRUCTION} keep:1`).compaction.summary as string;
  };

  test("a custom message (omp: developer) is read as injected user content", () => {
    const summary = summarize([
      user("Fix the parser"),
      { id: "c1", type: "custom_message", customType: "x", content: "INJECTED CARD", display: false, timestamp: "2026-01-01T00:00:00Z" },
      assistant("Parser fixed."),
      user("Now the docs"),
    ]);
    expect(summary).toContain("INJECTED CARD");
    const early = summary.split("[Early Session Requests]")[1]?.split("\n\n")[0] ?? "";
    expect(early).not.toContain("INJECTED CARD");
  });

  test("user text an extension sent for the agent is not read as a user message", () => {
    const summary = summarize([
      user("Fix the parser"),
      user("RELAYED BY AN EXTENSION", { attribution: "agent" }),
      assistant("Parser fixed."),
      user("Now the docs"),
    ]);
    const early = summary.split("[Early Session Requests]")[1]?.split("\n\n")[0] ?? "";
    expect(early).toContain("Fix the parser");
    expect(early).not.toContain("RELAYED BY AN EXTENSION");
  });

  test("a python cell is one >>> line; developer turns and @file contents are left out", () => {
    const summary = summarize([
      user("Fix the parser"),
      entry({ role: "pythonExecution", code: "print(parse('x'))\nprint(2)", output: "ok", exitCode: 0 }),
      entry({ role: "developer", content: "HOST REMINDER" }),
      entry({ role: "fileMention", files: [{ path: "notes.md", content: "SECRET FILE BODY" }] }),
      assistant("Parser fixed."),
      user("Now the docs"),
    ]);
    expect(summary).toMatch(/>>> print\(parse\('x'\)\); print\(2\)/);
    expect(summary).not.toContain("HOST REMINDER");
    expect(summary).not.toContain("SECRET FILE BODY");
  });
});

describe("omp entry: a turn still running", () => {
  // omp compacts between the tool calls of one turn. Here the live window is that
  // one turn, well under the tail budget: compact-all is the only cut left.
  const running = () => [
    user("Run seq 1 2000 and tell me the last number"),
    entry({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "seq 1 2000" } }] }),
    entry({ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "1\n2\n...\n2000" }] }),
  ];

  test("a threshold pass waits for the turn to end instead of summarizing it away", () => {
    const omp = createOmp();
    omp.setEntries(running());
    omp.fire("auto_compaction_start", { reason: "threshold", action: "context-full" });
    expect(omp.beforeCompact()).toEqual({ cancel: true });
    expect(omp.notices).toEqual([]);
  });

  test("an overflow pass goes to omp's own method", () => {
    const omp = createOmp();
    omp.setEntries(running());
    omp.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
    expect(omp.beforeCompact()).toBeUndefined();
  });

  test("once the turn has ended, the threshold pass compacts it", () => {
    const omp = createOmp();
    const entries = [...running(), assistant("2000")];
    omp.setEntries(entries);
    omp.fire("auto_compaction_start", { reason: "threshold", action: "context-full" });
    const { compaction } = omp.beforeCompact();
    expect(compaction.details).toMatchObject({ compactor: "omp-vcc", reason: "threshold" });
    // The final answer stays in context (omp's print mode prints it from there).
    expect(compaction.firstKeptEntryId).toBe(entries[3].id);
  });

  test("/omp-vcc still compacts a running turn when asked", () => {
    const omp = createOmp();
    omp.setEntries(running());
    expect(omp.beforeCompact(OMP_VCC_COMPACT_INSTRUCTION).compaction.firstKeptEntryId).toBe("");
  });
});
