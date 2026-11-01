// The omp entry (index.ts) against a fake omp extension API that hands it omp's
// real convertToLlm. tests/omp-host.test.ts runs the same entry inside a real omp.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
      ["agent_end", "auto_compaction_end", "auto_compaction_start", "before_agent_start", "message_end", "session_before_compact", "session_compact", "session_start"],
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

describe("omp entry: the model's real window", () => {
  const limitsFile = () => join(dir, "omp-vcc-models.json");
  const model = { provider: "electronhub", id: "small-model", api: "openai-completions", contextWindow: 128_000 };
  const big = () => Array.from({ length: 12 }, (_, i) => [user(`request ${i}: ${"word ".repeat(400)}`), assistant(`done ${i}: ${"word ".repeat(400)}`)]).flat();
  const overflow = (omp: ReturnType<typeof createOmp>, text: string) =>
    omp.fire("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: text, content: [] } });

  test("an overflow error that states the limit is learned, and the hook sizes by it", () => {
    rmSync(limitsFile(), { force: true });
    const omp = createOmp();
    omp.ctx.model = model;
    overflow(omp, "This model's maximum context length is 32768 tokens. However, you requested 40112 tokens.");
    expect(JSON.parse(readFileSync(limitsFile(), "utf8"))["electronhub/small-model"].contextWindow).toBe(32_768);
    omp.setEntries(big());
    const details = omp.beforeCompact().compaction.details;
    expect(details.limits).toMatchObject({ contextWindow: 32_768, windowSource: "overflow-error", trigger: 16_384 });
    expect(details.limits.maxTailTokens).toBeLessThan(25_000);
    rmSync(limitsFile(), { force: true });
  });

  test("a limit at or above omp's window teaches nothing; a window omp has right keeps the old budgets", () => {
    rmSync(limitsFile(), { force: true });
    const omp = createOmp();
    omp.ctx.model = model;
    overflow(omp, "maximum context length is 200000 tokens");
    expect(existsSync(limitsFile())).toBe(false);
    omp.setEntries(big());
    expect(omp.beforeCompact().compaction.details.limits).toMatchObject({ contextWindow: 128_000, windowSource: "omp", maxTailTokens: 25_000, briefCeilingTokens: 2_000 });
  });

  test("past omp-vcc's trigger on a model omp overestimates, a finished run is compacted, once noticed", async () => {
    recordLimit(32_768);
    const omp = createOmp();
    omp.ctx.model = model;
    omp.ctx.isIdle = () => true;
    let used = 10_000;
    omp.ctx.getContextUsage = () => ({ tokens: used, contextWindow: 128_000, percent: used / 1280 });
    omp.fire("agent_end", { messages: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(omp.compactCalls).toHaveLength(0); // under 16,384: nothing to do yet
    used = 20_000;
    omp.fire("agent_end", { messages: [], willContinue: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(omp.compactCalls).toHaveLength(0); // omp continues the run itself
    omp.setEntries(big());
    let details: any;
    omp.setCompact(async () => { details = omp.beforeCompact().compaction.details; });
    omp.fire("agent_end", { messages: [] });
    omp.fire("agent_end", { messages: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(omp.compactCalls).toHaveLength(1); // two run ends, one compaction
    expect(details).toMatchObject({ compactor: "omp-vcc", reason: "threshold" });
    expect(omp.notices.filter((n) => n.msg.includes("holds 32768 tokens (an overflow error said so), not the 128000 omp uses"))).toHaveLength(1);
    rmSync(limitsFile(), { force: true });
  });

  test("no compaction of its own with overrideDefaultCompaction off, or when omp's window is right", async () => {
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: false }));
    recordLimit(32_768);
    const off = createOmp();
    off.ctx.model = model;
    off.ctx.isIdle = () => true;
    off.ctx.getContextUsage = () => ({ tokens: 30_000, contextWindow: 128_000, percent: 23 });
    off.fire("agent_end", { messages: [] });
    rmSync(limitsFile(), { force: true });
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true }));
    const right = createOmp();
    right.ctx.model = model;
    right.ctx.isIdle = () => true;
    right.ctx.getContextUsage = () => ({ tokens: 120_000, contextWindow: 128_000, percent: 94 });
    right.fire("agent_end", { messages: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(off.compactCalls).toHaveLength(0);
    expect(right.compactCalls).toHaveLength(0); // omp's own trigger handles it
  });

  test("the provider's /models figure is used when smaller, and recorded when larger", async () => {
    const { probeProviderWindow, resetProviderProbes, startProviderProbe } = await import("../src/core/model-limits");
    resetProviderProbes();
    const registry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }) };
    const listing = (n: number) => async () => ({ ok: true, json: async () => ({ data: [{ id: model.id, context_length: n }] }) });
    const remote = { ...model, baseUrl: "https://provider.test/v1" };
    startProviderProbe(remote, registry, listing(65_536));
    await probeProviderWindow(remote, registry);
    await new Promise((r) => setTimeout(r, 0));
    const omp = createOmp();
    omp.ctx.model = remote;
    omp.setEntries(big());
    expect(omp.beforeCompact().compaction.details.limits).toMatchObject({ contextWindow: 65_536, windowSource: "provider", providerWindow: 65_536 });
    resetProviderProbes();
    const larger = { ...remote, baseUrl: "https://bigger.test/v1" };
    startProviderProbe(larger, registry, listing(1_000_000));
    await probeProviderWindow(larger, registry);
    await new Promise((r) => setTimeout(r, 0));
    omp.ctx.model = larger;
    expect(omp.beforeCompact().compaction.details.limits).toMatchObject({ contextWindow: 128_000, windowSource: "omp", providerWindow: 1_000_000 });
    resetProviderProbes();
  });

  // Seen live (40K provider): dense text tokenized at ~3 chars/token, so "context less
  // messages at 4 chars/token" doubled the overhead and pinned the tail at its floor.
  test("the overhead comes from the session's first request, which held little but the system prompt", () => {
    recordLimit(40_000);
    const omp = createOmp();
    omp.ctx.model = model;
    const usage = (input: number, cacheRead = 0) => ({ input, output: 50, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + 50 });
    const file = "x1 amber basil cedar ".repeat(1400); // ~29k chars
    const call = (id: string, n: number) => entry({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `data/${n}.txt` } }], usage: usage(8_393 + n * 9_000, 0) });
    const result = (id: string) => entry({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: file }], isError: false });
    omp.setEntries([
      user("Read the three data files and count their lines"),
      call("t1", 0), result("t1"), call("t2", 1), result("t2"), call("t3", 2), result("t3"),
      entry({ role: "assistant", content: [{ type: "text", text: "Each has 561 lines." }], usage: usage(14_014, 24_192), stopReason: "stop" }),
    ]);
    const out = omp.fire("session_before_compact", {
      preparation: { previousSummary: undefined, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, tokensBefore: 38_206 },
      branchEntries: omp.ctx.sessionManager.getBranch(), customInstructions: undefined, signal: new AbortController().signal,
    });
    const limits = out.compaction.details.limits;
    expect(limits.overheadTokens).toBeGreaterThan(8_300);
    expect(limits.overheadTokens).toBeLessThan(8_400);
    expect(limits.maxTailTokens).toBeGreaterThan(3_000); // was the 1,000 floor
    rmSync(limitsFile(), { force: true });
  });

  const recordLimit = (n: number) =>
    writeFileSync(limitsFile(), JSON.stringify({ "electronhub/small-model": { contextWindow: n, source: "overflow-error", at: "2026-11-01T00:00:00.000Z" } }));
});
