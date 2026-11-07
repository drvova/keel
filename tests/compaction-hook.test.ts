import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, jest } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OMP_VCC_COMPACT_INSTRUCTION } from "../src/core/compact-args";
import { formatCompactionStats } from "../src/compaction/stats";
import { applyTailBudget, buildOwnCut, getLastCompactionStats, registerHook, type RegisteredHook } from "./support/host";

let tmpDir: string;
let CONFIG_PATH: string;
const DEBUG_PATH = "/tmp/omp-vcc-debug.json";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omp-vcc-test-"));
  CONFIG_PATH = join(tmpDir, "omp-vcc-config.json");
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.OMP_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// The stats toast is shown 500 ms after session_compact (tellCompactionStats).
// Under fake timers, jest.runAllTimers() fires it, and anything else scheduled, at once.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

/** Register the hook on a fake omp API (tests/support/host.ts), as index.ts does. */
const register = (pi: any): RegisteredHook => (pi.__hook = registerHook(pi));

// Minimal omp ExtensionAPI stub: capture handlers + provide ctx with mocked ui.notify.
// invokeBefore takes the event with an optional `reason`: for an automatic one it
// fires auto_compaction_start first, as omp does, and the hook sees omp's event.
function createMockOmp() {
  let beforeHandler: ((event: any, ctx: any) => any) | undefined;
  let compactHandler: ((event: any, ctx: any) => any) | undefined;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const userMessages: Array<string | unknown[]> = [];
  const customMessages: Array<{ message: any; options: any }> = [];
  const ctx = {
    hasUI: true,
    model: undefined as any,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  };
  const pi = {
    on: (eventName: string, h: (e: any, c: any) => any) => {
      if (eventName === "session_before_compact") beforeHandler = h;
      if (eventName === "session_compact") compactHandler = h;
    },
    sendUserMessage: (content: string | unknown[]) => {
      userMessages.push(content);
    },
    sendMessage: (message: any, options: any) => {
      customMessages.push({ message, options });
    },
  } as any;
  return {
    pi,
    invokeBefore: (event: any) => {
      const { reason, willRetry: _willRetry, ...ompEvent } = event;
      if (reason && reason !== "manual") pi.__hook.autoCompactionStart(reason);
      return beforeHandler!(ompEvent, ctx);
    },
    invokeCompact: (event: any) => compactHandler!(event, ctx),
    notifyCalls,
    userMessages,
    customMessages,
    ctx,
  };
}
 
function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}
 
/** `trigger.reason`: what omp's auto_compaction_start says; invokeBefore fires it. */
function makeEvent(branchEntries: any[], customInstructions?: string, trigger: { reason?: string; willRetry?: boolean } = {}) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore: 1000,
    },
    signal: new AbortController().signal,
    ...trigger,
  };
}
 
const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});
const comp = (id: string, firstKeptEntryId?: string) => ({ id, type: "compaction", firstKeptEntryId });
const custom = (id: string, customType: string, content: string | unknown[], extra: Record<string, unknown> = {}) => ({ id, type: "custom_message", customType, content, display: false, timestamp: "2026-01-01T00:00:00.000Z", ...extra });
const branchSummary = (id: string, summary: string, fromId = "f1") => ({ id, type: "branch_summary", summary, fromId, timestamp: "2026-01-01T00:00:00.000Z" });
 
describe("compaction hook: cancel paths", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
 
  test("/omp-vcc with too few live messages cancels and notifies warning", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore, notifyCalls } = createMockOmp();
    register(pi);
 
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("Too few messages");
  });
 
  test("/omp-vcc with no user message compacts all instead of cancelling", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore, notifyCalls } = createMockOmp();
    register(pi);
 
    const entries = [msg("m1", "assistant"), msg("m2", "assistant"), msg("m3", "assistant")];
    const result = invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION));
    // No longer cancels — compacts all to recover from context overflow
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("");
  });
 
  test("/compact with override=true and too few messages cancels with a warning", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, notifyCalls } = createMockOmp();
    register(pi);
 
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, undefined))).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
  });
 
  test("/compact with override=false short-circuits (no notify, returns undefined)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore, notifyCalls } = createMockOmp();
    register(pi);
 
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, undefined))).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
  });
 
  test("an overflow with too few messages to cut summarizes them whole, or says why it cannot help", () => {
    setConfig({ debug: true, overrideDefaultCompaction: true });
    const { pi, invokeBefore, notifyCalls } = createMockOmp();
    register(pi);

    // A paste far bigger than its summary: summarized whole, its original in recall.
    const paste = [msg("m1", "user", `Here is the dump: ${"0xdeadbeef ".repeat(4_000)}`), msg("m2", "assistant", "Reading it.")];
    const whole = invokeBefore(makeEvent(paste, undefined, { reason: "overflow" }));
    expect(whole.compaction.firstKeptEntryId).toBe("");
    expect(whole.compaction.details).toMatchObject({ compactor: "omp-vcc", reason: "overflow", willRetry: true });

    // Two tiny messages beside long pinned notes: any summary of them is bigger
    // than they are, and no method of omp's would shrink this context either.
    const pins = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, type: "custom", customType: "omp-vcc.pin",
      data: { v: 1, op: "add", id: i + 1, text: `Constraint ${i + 1}: ${"keep the legacy SSO flow untouched until the migration lands. ".repeat(3)}`, by: "user" },
    }));
    const tiny = [...pins, msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(tiny, undefined, { reason: "overflow" }))).toEqual({ cancel: true });
    expect(notifyCalls.at(-1)?.msg).toContain("the context is full of what no compaction removes");
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.compaction).toEqual({ reason: "overflow", willRetry: true });
  });

  test("debug:true writes metrics-only snapshot on cancel with no content leakage", () => {
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
 
    // Use too_few_live_messages cancel path to test content leakage
    const entries = [
      msg("m1", "user", "SECRET_TOKEN_abc123"),
      msg("m2", "assistant", "sensitive response"),
    ];
    expect(invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
 
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.cancelled).toBe(true);
    expect(snapshot.reason).toBe("too_few_live_messages");
 
    // No content leakage
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("SECRET_TOKEN_abc123");
    expect(serialized).not.toContain("sensitive response");
  });
 
  test("debug:false does NOT write snapshot", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(existsSync(DEBUG_PATH)).toBe(false);
  });
});
 
describe("compaction hook: compact-all path", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });
 
  test("single-user + autonomous tail → returns compaction with empty firstKeptEntryId", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore, notifyCalls } = createMockOmp();
    register(pi);
 
    const entries = [
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "done"),
    ];
    const result = invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("");
    expect(notifyCalls).toHaveLength(0); // no cancel notify on success
  });
 
  test("manual /omp-vcc marker still compacts and records reason metadata", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    const result = invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, { reason: "manual", willRetry: false }));

    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("m3");
    expect(result.compaction.details).toMatchObject({ reason: "manual", willRetry: false });
  });

  test("threshold override still compacts and records reason metadata", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    const result = invokeBefore(makeEvent(entries, undefined, { reason: "threshold", willRetry: false }));

    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("m3");
    expect(result.compaction.details).toMatchObject({ reason: "threshold", willRetry: false });
  });

  test("an automatic compaction sends no continue of its own: omp resumes the run itself", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, customMessages, userMessages, notifyCalls } = createMockOmp();
    register(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    const result = invokeBefore(makeEvent(entries, undefined, { reason: "threshold" }));
    await invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: result.compaction.details } });
    jest.runAllTimers();

    expect(customMessages).toEqual([]);
    expect(userMessages).toEqual([]);
    // Compaction itself is untouched: the stats toast still fires.
    expect(notifyCalls.some((call) => call.msg.startsWith("omp-vcc: kept"))).toBe(true);
  });

  test("explicit /compact follow-up prompt is sent after the compaction, with the stats toast", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages, customMessages, notifyCalls } = createMockOmp();
    register(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, "continue"));
    await invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "omp-vcc" } } });
    jest.runAllTimers();

    expect(userMessages).toEqual(["continue"]);
    expect(customMessages).toEqual([]);
    expect(notifyCalls.some((call) => call.msg.startsWith("omp-vcc: kept 1/2 turns,"))).toBe(true);
  });

  test("in print mode the outcome line of an automatic pass goes to stderr, as its reasons do", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, ctx } = createMockOmp();
    ctx.hasUI = false;
    register(pi);
    const written: string[] = [];
    const write = process.stderr.write;
    (process.stderr as any).write = (chunk: string) => (written.push(String(chunk)), true);
    try {
      invokeBefore(makeEvent([msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")], undefined, { reason: "threshold" }));
      await invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "omp-vcc", reason: "threshold", willRetry: false } } });
    } finally {
      (process.stderr as any).write = write;
    }
    expect(written.some((w) => w.startsWith("omp-vcc: kept 1/2 turns,"))).toBe(true);
  });

  test("follow-up prompt does not block compact metrics notify", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages, notifyCalls } = createMockOmp();
    pi.sendUserMessage = (content: string | unknown[]) => {
      userMessages.push(content);
      return new Promise(() => {});
    };
    register(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, "continue"));

    invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "omp-vcc" } } });
    jest.runAllTimers();

    expect(userMessages).toEqual(["continue"]);
    expect(notifyCalls.some((call) => call.msg.startsWith("omp-vcc: kept 1/2 turns,"))).toBe(true);
  });

  test("override=true + /compact keep prefix keeps requested turns and strips follow-up", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages } = createMockOmp();
    register(pi);

    const entries = [
      msg("m1", "user"), msg("m2", "assistant"),
      msg("m3", "user"), msg("m4", "assistant"),
      msg("m5", "user"), msg("m6", "assistant"),
      msg("m7", "user"), msg("m8", "assistant"),
    ];
    const result = invokeBefore(makeEvent(entries, "keep:3 continue"));
    await invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "omp-vcc" } } });
    jest.runAllTimers();

    expect(result.compaction.firstKeptEntryId).toBe("m3");
    expect(getLastCompactionStats()).toMatchObject({
      keptUserTurns: 3,
      totalUserTurns: 4,
    });
    expect(userMessages).toEqual(["continue"]);
  });

  test("override=true + /compact keep suffix keeps requested turns and strips follow-up", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages } = createMockOmp();
    register(pi);

    const entries = [
      msg("m1", "user"), msg("m2", "assistant"),
      msg("m3", "user"), msg("m4", "assistant"),
      msg("m5", "user"), msg("m6", "assistant"),
    ];
    const result = invokeBefore(makeEvent(entries, "continue keep:2"));
    await invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "omp-vcc" } } });
    jest.runAllTimers();

    expect(result.compaction.firstKeptEntryId).toBe("m3");
    expect(getLastCompactionStats()).toMatchObject({
      keptUserTurns: 2,
      totalUserTurns: 3,
    });
    expect(userMessages).toEqual(["continue"]);
  });

  test("session_compact overflow retry does not send follow-up prompt", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages, customMessages, notifyCalls } = createMockOmp();
    register(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    const result = invokeBefore(makeEvent(entries, "continue", { reason: "overflow" }));
    expect(result.compaction.details).toMatchObject({ reason: "overflow", willRetry: true });
    await invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: result.compaction.details } });
    jest.runAllTimers();

    expect(userMessages).toEqual([]);
    expect(customMessages).toEqual([]);
    expect(notifyCalls).toEqual([]);
  });

  test("formatCompactionStats shows kept 0/N for a compact-all fallback, explicit keep or default, without extra wording", () => {
    const fallback = { summarized: 2, keptUserTurns: 0, keptTokensEst: 10 };
    expect(formatCompactionStats({ ...fallback, totalUserTurns: 2 })).toBe("omp-vcc: kept 0/2 turns, ~10 tok (summarized 2).");
    expect(formatCompactionStats({ ...fallback, totalUserTurns: 1 })).toBe("omp-vcc: kept 0/1 turns, ~10 tok (summarized 2).");
  });

  test("formatCompactionStats appends smart-keep tag when adjusted", () => {
    const msg = formatCompactionStats({
      summarized: 5,
      keptUserTurns: 3,
      totalUserTurns: 5,
      keptTokensEst: 3200,
      smartKeepAdjusted: true,
    });
    expect(msg).toBe("omp-vcc: kept 3/5 turns, ~3.2k tok (summarized 5, smart-keep).");
  });

  test("/omp-vcc keep instruction changes firstKeptEntryId and stats", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "reply three"),
    ];

    const result = invokeBefore(makeEvent(entries, `${OMP_VCC_COMPACT_INSTRUCTION} keep:2`));

    expect(result.compaction.firstKeptEntryId).toBe("u2");
    expect(result.compaction.details.sourceMessageCount).toBe(2);
    expect(getLastCompactionStats()).toMatchObject({
      summarized: 2,
      keptUserTurns: 2,
      totalUserTurns: 3,
    });
  });

  test("/omp-vcc marker with trailing prompt does not leak marker as follow-up", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages } = createMockOmp();
    register(pi);
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "reply three"),
    ];

    const result = invokeBefore(makeEvent(entries, `${OMP_VCC_COMPACT_INSTRUCTION} keep:2 continue`));
    await invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "omp-vcc", reason: "manual", willRetry: false } } });
    jest.runAllTimers();

    expect(result.compaction.firstKeptEntryId).toBe("u2");
    expect(getLastCompactionStats()).toMatchObject({
      keptUserTurns: 2,
    });
    expect(userMessages).toEqual([]);
  });

  test("huge keep instruction compacts all safely", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const entries = [msg("u1", "user", "one"), msg("a1", "assistant", "reply one"), msg("u2", "user", "two"), msg("a2", "assistant", "reply two")];

    const result = invokeBefore(makeEvent(entries, `${OMP_VCC_COMPACT_INSTRUCTION} keep:999999999999999999999`));

    expect(result.compaction.firstKeptEntryId).toBe("");
    expect(getLastCompactionStats()).toMatchObject({
      keptUserTurns: 0,
      totalUserTurns: 2,
    });
  });
});

describe("applyTailBudget: token-budget tail cut (default path)", () => {
  const big = (n: number) => "x".repeat(n);

  test("Case A: no user anchor + oversized live window → non-compact-all budget cut (no_anchor)", () => {
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", "res"),
      msg("a2", "assistant", big(200_000)), // 50k tok at 4 chars/tok
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.compactAll).toBe(true);

    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compactAll).toBe(false);
    expect(result.firstKeptEntryId).toBe("a2");
    expect(result.firstKeptEntryId).not.toBe("");
    expect(result.budgetCut).toBe("no_anchor");
    const keptFirst = entries.find((e: any) => e.id === result.firstKeptEntryId)!;
    expect(keptFirst.message.role).not.toBe("toolResult");
  });

  test("Case A small window: everything < budget → unchanged compact-all fallback", () => {
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", "res"),
      msg("a2", "assistant", "done"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result).toEqual(cut); // returned unchanged
    if (!result.ok) return;
    expect(result.compactAll).toBe(true);
    expect(result.firstKeptEntryId).toBe("");
    expect(result.budgetCut).toBeUndefined();
  });

  test("Case B: oversized tail (>62.5k tok) re-cuts inside the last turn, not at toolResult", () => {
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", big(300_000)), // 75k tok at 4 chars/tok
      msg("t1", "toolResult", "res"),
      msg("a3", "assistant", "wrap"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.compactAll).toBe(false);
    expect(cut.firstKeptEntryId).toBe("u2");

    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budgetCut).toBe("oversized_tail");
    expect(result.compactAll).toBe(false);
    expect(result.firstKeptEntryId).toBe("a2"); // cut landed inside the last turn
    const keptFirst = entries.find((e: any) => e.id === result.firstKeptEntryId)!;
    expect(keptFirst.message.role).toBe("assistant");
  });

  test("Case B tolerance: last turn ~37.5k tok → no budget cut", () => {
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", big(150_000)), // 37.5k tok at 4 chars/tok < 62.5k
      msg("t1", "toolResult", "res"),
      msg("a3", "assistant", "wrap"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result).toEqual(cut); // tolerance zone: unchanged
    if (!result.ok) return;
    expect(result.budgetCut).toBeUndefined();
    expect(result.firstKeptEntryId).toBe("u2");
  });

  test("toolResult snap: crossing lands on a toolResult → snapped forward to next non-toolResult", () => {
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", big(200_000)), // crossing lands here
      msg("a2", "assistant", "done"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.compactAll).toBe(true);
    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budgetCut).toBe("no_anchor");
    expect(result.firstKeptEntryId).toBe("a2"); // snapped past the toolResult
    const keptFirst = entries.find((e: any) => e.id === result.firstKeptEntryId)!;
    expect(keptFirst.message.role).toBe("assistant");
  });

  test("formatCompactionStats leads with tail tokens for budget cuts", () => {
    const base = {
      summarized: 4,
      keptUserTurns: 0,
      totalUserTurns: 1,
      keptTokensEst: 5000,
    };
    expect(formatCompactionStats({ ...base, budgetCut: "no_anchor" })).toBe("omp-vcc: kept ~5.0k tok tail (mid-turn cut, no user anchor), summarized 4.");
    expect(formatCompactionStats({ ...base, budgetCut: "oversized_tail" })).toBe("omp-vcc: kept ~5.0k tok tail (mid-turn cut, oversized tail), summarized 4.");
    // A finished turn whose final reply was kept is not a mid-turn cut (seen with a real model).
    expect(formatCompactionStats({ ...base, budgetCut: "final_reply" })).toBe("omp-vcc: kept the final reply (~5.0k tok), summarized 4.");
    expect(formatCompactionStats({ ...base, budgetCut: "running_turn" })).toBe("omp-vcc: kept the running turn's latest steps (~5.0k tok), summarized 4.");
  });
});

describe("compaction hook: budget-cut hook integration", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  test("Case A default path: no_anchor budget cut keeps a tail and sets stats", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", "res"),
      msg("a2", "assistant", "x".repeat(200_000)),
    ];
    const result = invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION));
    expect(result.cancel).toBeUndefined();
    expect(result.compaction.firstKeptEntryId).not.toBe("");
    expect(getLastCompactionStats()!.budgetCut).toBe("no_anchor");
  });

  test("Case A small window: unchanged compact-all fallback and no budgetCut", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", "res"),
      msg("a2", "assistant", "done"),
    ];
    const result = invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction.firstKeptEntryId).toBe("");
    expect(getLastCompactionStats()!.budgetCut).toBeUndefined();
  });

  test("Explicit keep:N with giant last turn is untouched (no budgetCut)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "x".repeat(300_000)),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "reply three"),
    ];
    const result = invokeBefore(makeEvent(entries, `${OMP_VCC_COMPACT_INSTRUCTION} keep:2`));
    expect(result.compaction.firstKeptEntryId).toBe("u2");
    expect(getLastCompactionStats()!.budgetCut).toBeUndefined();
  });
});

describe("the cut: custom_message and branch_summary entries", () => {
  test("custom_message in the summarized prefix is carried into the summarizer input", () => {
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "reply"),
      custom("c1", "memory-inject", "CUSTOM_CTX_MARKER_123"),
      msg("u2", "user", "next"),
      msg("a2", "assistant", "done"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // keep:1 → cut at u2, so the summarized prefix is [u1, a1, c1]
    expect(cut.firstKeptEntryId).toBe("u2");
    const summarized = cut.messages.map((m: any) => m.content);
    expect(summarized).toContain("CUSTOM_CTX_MARKER_123");
    const customMsg = cut.messages.find((m: any) => m.role === "custom");
    expect(customMsg).toBeDefined();
    expect(customMsg.customType).toBe("memory-inject");
  });

  test("custom_message is NOT counted as a user turn", () => {
    const entries = [
      msg("u1", "user", "one"),
      custom("c1", "ctx", "injected"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.totalUserTurns).toBe(2); // custom not counted
    expect(cut.keptUserTurns).toBe(1);
  });

  test("branch_summary entry is included and not counted as a user turn", () => {
    const entries = [
      branchSummary("bs1", "BRANCH_SUMMARY_MARKER"),
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.totalUserTurns).toBe(2); // branch_summary not counted
    const prefix = cut.messages.map((m: any) => m.content ?? m.summary);
    expect(prefix).toContain("BRANCH_SUMMARY_MARKER");
    const bsMsg = cut.messages.find((m: any) => m.role === "branchSummary");
    expect(bsMsg).toBeDefined();
    expect(bsMsg.summary).toBe("BRANCH_SUMMARY_MARKER");
  });

  test("budget cut may land on a custom message (valid non-toolResult boundary)", () => {
    const entries = [
      msg("u1", "user", "go"),
      custom("c1", "ctx", "x".repeat(200_000)), // huge custom message
      msg("a1", "assistant", "wrap"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.compactAll).toBe(true); // no user anchor → case A
    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budgetCut).toBe("no_anchor");
    expect(result.firstKeptEntryId).toBe("c1"); // cut landed on the custom message
    const keptFirst = entries.find((e: any) => e.id === result.firstKeptEntryId)!;
    expect(keptFirst.type).toBe("custom_message");
  });

  test("orphan-recovery window containing custom_message keeps it in the live window", () => {
    const entries = [
      comp("pc", "ghost-id"), // prior compaction with a no-longer-valid kept id
      custom("c1", "ctx", "ORPHAN_CUSTOM_MARKER"),
      msg("a1", "assistant", "reply"),
      msg("u1", "user", "go"),
      msg("a2", "assistant", "done"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // orphan recovery collects from after the last compaction → custom is included
    const summarized = cut.messages.map((m: any) => m.content).join("");
    expect(summarized).toContain("ORPHAN_CUSTOM_MARKER");
    expect(cut.totalUserTurns).toBe(1);
  });
});

describe("compaction hook: only what the user wrote is read as user messages", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  test("extension messages and !cmd runs stay in the transcript but out of the user sections", () => {
    setConfig({ overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const entries = [
      msg("u0", "user", "Fix the login bug"),
      custom("c1", "peer-relay", "Relay from peer RELAY_MARKER_77\nNever run reviewer children during a window"),
      { id: "b1", type: "message", message: { role: "bashExecution", command: "echo BASH_MARKER_88", output: "OUTPUT_MARKER_99", exitCode: 0 } },
      msg("u1", "user", "go"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "next"),
      msg("a2", "assistant", "done"),
      msg("u3", "user", "more"),
      msg("a3", "assistant", "ok"),
    ];
    const summary: string = invokeBefore(makeEvent(entries)).compaction.summary;
    expect(summary).toContain("RELAY_MARKER_77");
    const head = summary.slice(0, summary.indexOf("\n---\n"));
    expect(head).toContain("Fix the login bug");
    expect(head).not.toContain("RELAY_MARKER_77");
    expect(head).not.toContain("reviewer children");
    // A !cmd is one transcript line; its output is left to vcc_recall.
    expect(summary).toMatch(/^\$ echo BASH_MARKER_88$/m); // no session file here, so no (#N) ref
    expect(summary).not.toContain("OUTPUT_MARKER_99");
    expect(head).not.toContain("BASH_MARKER_88");
  });

  test("a branch's summary stays in the transcript but is no request of the user's", () => {
    setConfig({ overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const entries = [
      branchSummary("bs1", "BRANCH_SUMMARY_MARKER tried the other parser"),
      msg("u1", "user", "Fix the login bug"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "next"),
      msg("a2", "assistant", "done"),
    ];
    const summary: string = invokeBefore(makeEvent(entries, `${OMP_VCC_COMPACT_INSTRUCTION} keep:1`)).compaction.summary;
    expect(summary).toContain("BRANCH_SUMMARY_MARKER");
    const head = summary.slice(0, summary.indexOf("\n---\n"));
    expect(head).toContain("[Early Session Requests]\n- Fix the login bug");
    expect(head).not.toContain("BRANCH_SUMMARY_MARKER");
  });
});

describe("compaction hook: skipForProviders (#27)", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  const entries = () => [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];

  test("auto compaction is deferred when ctx.model.provider is in skipForProviders", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, skipForProviders: ["openai"] });
    const mock = createMockOmp();
    mock.ctx.model = { provider: "openai" };
    register(mock.pi);
    expect(mock.invokeBefore(makeEvent(entries(), undefined, { reason: "threshold" }))).toBeUndefined();
  });

  test("matching is exact and case-insensitive (no substring)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, skipForProviders: ["OpenAI"] });
    const mock = createMockOmp();
    mock.ctx.model = { provider: "openai" };
    register(mock.pi);
    expect(mock.invokeBefore(makeEvent(entries(), undefined, { reason: "threshold" }))).toBeUndefined();

    const mock2 = createMockOmp();
    mock2.ctx.model = { provider: "openai-compatible" };
    register(mock2.pi);
    expect(mock2.invokeBefore(makeEvent(entries(), undefined, { reason: "threshold" }))?.compaction).toBeTruthy();
  });

  test("provider not in list still compacts", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, skipForProviders: ["openai"] });
    const mock = createMockOmp();
    mock.ctx.model = { provider: "anthropic" };
    register(mock.pi);
    expect(mock.invokeBefore(makeEvent(entries(), undefined, { reason: "threshold" }))?.compaction).toBeTruthy();
  });

  test("explicit /omp-vcc bypasses the provider skip", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, skipForProviders: ["openai"] });
    const mock = createMockOmp();
    mock.ctx.model = { provider: "openai" };
    register(mock.pi);
    expect(mock.invokeBefore(makeEvent(entries(), OMP_VCC_COMPACT_INSTRUCTION))?.compaction).toBeTruthy();
  });

  test("undefined model never skips", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, skipForProviders: ["openai"] });
    const mock = createMockOmp(); // ctx.model stays undefined
    register(mock.pi);
    expect(mock.invokeBefore(makeEvent(entries(), undefined, { reason: "threshold" }))?.compaction).toBeTruthy();
  });

  test("malformed skipForProviders (string not array) coerces to []", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, skipForProviders: "openai" });
    const mock = createMockOmp();
    mock.ctx.model = { provider: "openai" };
    register(mock.pi);
    // A bare string would substring-match ("openai".includes("openai")) without coercion.
    expect(mock.invokeBefore(makeEvent(entries(), undefined, { reason: "threshold" }))?.compaction).toBeTruthy();
  });

  test("session_compact ignores a compaction omp-vcc did not handle", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, skipForProviders: ["openai"] });
    const mock = createMockOmp();
    register(mock.pi);

    // omp-vcc compacts once (anthropic) → stale stats now exist.
    mock.ctx.model = { provider: "anthropic" };
    const own = mock.invokeBefore(makeEvent(entries(), undefined, { reason: "threshold" }));
    await mock.invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: own.compaction.details } });
    jest.runAllTimers();
    const notifiesAfterVcc = mock.notifyCalls.length;
    expect(notifiesAfterVcc).toBe(1); // stats toast for omp-vcc's own compaction

    // Model switches to a skipped provider → omp-vcc defers; another extension compacts.
    mock.ctx.model = { provider: "openai" };
    expect(mock.invokeBefore(makeEvent(entries(), "continue", { reason: "threshold" }))).toBeUndefined();
    await mock.invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "other-compaction" } } });
    jest.runAllTimers();

    // No stale toast or follow-up on someone else's compaction.
    expect(mock.notifyCalls.length).toBe(notifiesAfterVcc);
    expect(mock.userMessages).toEqual([]);
  });

  test("load-order race: omp-vcc returned a compaction but another extension's won persist", async () => {
    // The runner keeps the LAST non-null session_before_compact result, so
    // when omp-vcc and another compaction extension both answer, whoever loads
    // later wins. session_compact must trust the persisted entry's details,
    // not whether omp-vcc happened to return something.
    setConfig({ debug: false, overrideDefaultCompaction: true }); // no skipForProviders yet
    const mock = createMockOmp();
    mock.ctx.model = { provider: "openai" };
    register(mock.pi);

    // omp-vcc produced a compaction (with a follow-up prompt)...
    expect(mock.invokeBefore(makeEvent(entries(), "continue"))?.compaction).toBeTruthy();
    // ...but the other extension loaded later and its entry was persisted.
    await mock.invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "other-compaction" } } });
    jest.runAllTimers();

    expect(mock.notifyCalls).toEqual([]); // no stats toast for someone else's compaction
    expect(mock.userMessages).toEqual([]);
  });

  test("a compaction stored under the old pi-vcc name still counts as omp-vcc's", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const mock = createMockOmp();
    register(mock.pi);
    expect(mock.invokeBefore(makeEvent(entries(), "continue"))?.compaction).toBeTruthy();
    await mock.invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "pi-vcc" } } });
    jest.runAllTimers();
    expect(mock.userMessages).toEqual(["continue"]);
  });

});

describe("compaction hook: skipCustomTypes", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  // Smart-keep lifts the tail to ~2 user turns, so entries before u2 land
  // in the summarized window: [c1, u1, a1]. Custom entries must sit early
  // to be inside that window.
  // u0 keeps the summarized prefix non-empty once c1 is filtered out; without
  // it, skipping c1 would leave nothing to summarize and the cut must move.
  const baseEntries = () => [
    msg("u0", "user", "start"),
    custom("c1", "memory-inject", "INJECTED_BOILERPLATE_XYZ"),
    msg("u1", "user", "go"),
    msg("a1", "assistant", "reply"),
    msg("u2", "user", "next"),
    msg("a2", "assistant", "done"),
    msg("u3", "user", "more"),
    msg("a3", "assistant", "ok"),
  ];

  // Uses the /compact path (no customInstructions) so session_compact emits
  // the stats toast — the /omp-vcc path shows its own onComplete toast instead.
  const runCompact = (skipCustomTypes: unknown) => {
    setConfig({ overrideDefaultCompaction: true, skipCustomTypes });
    const { pi, invokeBefore, invokeCompact, notifyCalls } = createMockOmp();
    register(pi);
    const result = invokeBefore(makeEvent(baseEntries()));
    return { result, summary: result.compaction.summary as string, invokeCompact, notifyCalls };
  };

  // custom_message text reaches the summary (the hook reads it as user
  // content), which is what makes skipping worthwhile.
  test("a listed customType is left out of the summary; others, and every one when none is listed, stay", () => {
    expect(runCompact([]).summary).toContain("INJECTED_BOILERPLATE_XYZ");
    const entries = [
      custom("c1", "memory-inject", "INJECTED_BOILERPLATE_XYZ"),
      custom("c2", "other-ext-note", "KEEP_ME_MARKER", { display: true }),
      msg("u1", "user", "go"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "next"),
      msg("a2", "assistant", "done"),
      msg("u3", "user", "more"),
      msg("a3", "assistant", "ok"),
    ];
    setConfig({ overrideDefaultCompaction: false, skipCustomTypes: ["memory-inject"] });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const { summary } = invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION)).compaction;
    expect(summary).not.toContain("INJECTED_BOILERPLATE_XYZ");
    expect(summary).toContain("KEEP_ME_MARKER");
  });

  const keptToastOf = async (run: ReturnType<typeof runCompact>) => {
    await run.invokeCompact({ type: "session_compact", fromExtension: true, compactionEntry: { details: { compactor: "omp-vcc", reason: "threshold", willRetry: false } } });
    jest.runAllTimers();
    return run.notifyCalls.find((c: { msg: string }) => c.msg.startsWith("omp-vcc: kept"))?.msg;
  };

  test("filtering does not move the cut: firstKeptEntryId and kept turns identical on/off", async () => {
    const on = runCompact(["memory-inject"]);
    const onToast = await keptToastOf(on);
    const off = runCompact([]);
    const offToast = await keptToastOf(off);
    const summarized = (run: ReturnType<typeof runCompact>): number => run.result.compaction.details.sourceMessageCount;

    expect(on.result.compaction.firstKeptEntryId).toBe(off.result.compaction.firstKeptEntryId);
    expect(summarized(on)).toBe(summarized(off) - 1);
    // Kept-turn counting is upstream of the filter → identical toast prefix.
    expect(onToast?.match(/kept \d+\/\d+ turns/)?.[0]).toBe(offToast?.match(/kept \d+\/\d+ turns/)?.[0]);
    // And the summarized count reflects the filtered input.
    expect(onToast).toContain(`summarized ${summarized(on)}`);
    expect(offToast).toContain(`summarized ${summarized(off)}`);
  });

  test("malformed skipCustomTypes (bare string) fails closed: nothing skipped", () => {
    expect(runCompact("memory-inject").summary).toContain("INJECTED_BOILERPLATE_XYZ");
  });

  test("default (no setting) keeps current behavior: nothing skipped", () => {
    setConfig({ overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const { summary } = invokeBefore(makeEvent(baseEntries(), OMP_VCC_COMPACT_INSTRUCTION)).compaction;
    expect(summary).toContain("INJECTED_BOILERPLATE_XYZ");
  });
});

describe("compaction hook: trackCommands", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  // The setting must reach the summary through the real hook path:
  // config file -> loadSettings -> compile -> [Tracked Commands].
  const bashCall = (id: string, command: string) => ({
    id,
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: `t-${id}`, name: "bash", arguments: { command } }] },
  });
  const entries = () => [
    msg("u0", "user", "start"),
    bashCall("a0", "docker ps -a 2>&1"),
    msg("u1", "user", "go"),
    msg("a1", "assistant", "reply"),
    msg("u2", "user", "next"),
    msg("a2", "assistant", "done"),
    msg("u3", "user", "more"),
    msg("a3", "assistant", "ok"),
  ];
  const summaryWith = (cfg: Record<string, unknown>) => {
    setConfig({ overrideDefaultCompaction: true, ...cfg });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    return invokeBefore(makeEvent(entries())).compaction.summary as string;
  };

  test("listed commands appear in [Tracked Commands]; no section by default", () => {
    expect(summaryWith({ trackCommands: ["docker"] })).toContain("[Tracked Commands]\n- docker: docker ps -a 2>&1");
    expect(summaryWith({})).not.toContain("[Tracked Commands]");
  });
});

// From a sibling omp port's audit: omp's plan-mode "approve and compact" grew a
// context from 85K to 87K, a two-message prefix replaced by a bigger summary.
describe("compaction hook: growth guard", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  const pinned = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, type: "custom", customType: "omp-vcc.pin",
    data: { v: 1, op: "add", id: i + 1, text: `Constraint ${i + 1}: ${"keep the legacy SSO flow untouched until the migration lands. ".repeat(3)}`, by: "user" },
  }));
  const tiny = () => [...pinned(5), msg("m1", "user", "ok go"), msg("m2", "assistant", "done"), msg("m3", "user", "next"), msg("m4", "assistant", "fine")];

  test("an automatic pass that would grow the context is cancelled quietly", () => {
    setConfig({ overrideDefaultCompaction: true });
    const { pi, invokeBefore, notifyCalls } = createMockOmp();
    register(pi);
    expect(invokeBefore(makeEvent(tiny(), undefined, { reason: "threshold" }))).toEqual({ cancel: true });
    expect(notifyCalls).toEqual([]);
  });

  test("a manual /compact that would grow it is cancelled and says why; an overflow writes it for omp's rescue", () => {
    setConfig({ overrideDefaultCompaction: true });
    const manual = createMockOmp();
    register(manual.pi);
    expect(manual.invokeBefore(makeEvent(tiny(), undefined))).toEqual({ cancel: true });
    expect(manual.notifyCalls[0].msg).toStartWith("omp-vcc: Not compacted: the summary would be");
    expect(manual.notifyCalls[0].msg).toContain("keep:0 summarizes everything");
    // Already summarizing everything: no keep:0 hint.
    const all = createMockOmp();
    register(all.pi);
    expect(all.invokeBefore(makeEvent(tiny(), "keep:0"))).toEqual({ cancel: true });
    expect(all.notifyCalls[0].msg).toStartWith("omp-vcc: Not compacted: the summary would be");
    expect(all.notifyCalls[0].msg).not.toContain("keep:0");
    const overflow = createMockOmp();
    register(overflow.pi);
    // Recovering, it keeps part of the window, and what overflows is that part: written, and omp's rescue shakes it.
    expect(overflow.invokeBefore(makeEvent(tiny(), undefined, { reason: "overflow" })).compaction.details).toMatchObject({ compactor: "omp-vcc", reason: "overflow" });
  });

  test("a prefix worth summarizing still compacts", () => {
    setConfig({ overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const long = [...pinned(5), msg("m1", "user", "x ".repeat(3_000)), msg("m2", "assistant", "y ".repeat(3_000)), msg("m3", "user", "next"), msg("m4", "assistant", "fine")];
    expect(invokeBefore(makeEvent(long, undefined, { reason: "threshold" })).compaction).toBeDefined();
  });
});

describe("compaction hook: section sizes follow the window", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  const session = () => Array.from({ length: 24 }, (_, i) => [
    msg(`u${i}`, "user", `please update module ${i} and keep its public API stable`),
    msg(`a${i}`, "assistant", `Updated module ${i}. ${"The change keeps every exported name and signature as it was. ".repeat(4)}`),
  ]).flat();
  const userLines = (summary: string) => (summary.split("[User Messages]\n")[1] ?? "").split("\n\n")[0].split("\n").filter((l) => l.startsWith("- ")).length;

  test("a small window keeps fewer user messages, and the details say by how much", () => {
    setConfig({ overrideDefaultCompaction: true });
    const typical = createMockOmp();
    register(typical.pi);
    const big = typical.invokeBefore(makeEvent(session(), "keep:1"));
    expect(userLines(big.compaction.summary)).toBe(15);
    expect(big.compaction.details.limits.summaryScale).toBeUndefined();

    const small = createMockOmp();
    small.ctx.model = { contextWindow: 16_384 };
    register(small.pi);
    const out = small.invokeBefore(makeEvent(session(), "keep:1"));
    expect(userLines(out.compaction.summary)).toBe(5);
    expect(out.compaction.details.limits).toMatchObject({ contextWindow: 16_384, summaryScale: 0.36 });
  });
});

describe("what a compaction stores for the next one", () => {
  test("details name the sections shown, and hold the carried sections the next compaction merges into", () => {
    const { pi, invokeBefore } = createMockOmp();
    register(pi);
    const first = [
      msg("u1", "user", "fix the login bug"),
      msg("a1", "assistant", "looking"),
      msg("u2", "user", "and the signup form"),
      msg("a2", "assistant", "done"),
    ];
    const one = invokeBefore(makeEvent(first, `${OMP_VCC_COMPACT_INSTRUCTION} keep:1`));
    const { details, summary } = one.compaction;
    // The brief's [user] and [assistant] blocks are not sections.
    expect(details.sections).toEqual(["Task State", "Early Session Requests"]);
    expect(details.summaryState.earlyRequests).toEqual(["fix the login bug"]);

    // The next compaction merges into that state, not the text: a summary text that
    // says something else is not read when the stored state is there.
    const compaction = { id: "c1", type: "compaction", summary, firstKeptEntryId: "u2", details };
    const event = makeEvent([...first, compaction, msg("u3", "user", "now the password reset"), msg("a3", "assistant", "ok")], `${OMP_VCC_COMPACT_INSTRUCTION} keep:1`);
    event.preparation.previousSummary = "[Early Session Requests]\n- something the text alone says" as any;
    const two = invokeBefore(event);
    expect(two.compaction.details.summaryState.earlyRequests).toEqual(["fix the login bug", "and the signup form"]);
    expect(two.compaction.summary).not.toContain("something the text alone says");
  });
});

describe("what the hook tells the user", () => {
  test("a cancel's reason goes to the UI, or to stderr where there is none (print and json modes)", () => {
    const entries = [msg("u1", "user", "hi"), msg("a1", "assistant", "hello")];
    const ui = createMockOmp();
    register(ui.pi);
    expect(ui.invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION)).cancel).toBe(true);
    expect(ui.notifyCalls.map((c) => c.msg)).toEqual(["omp-vcc: Too few messages to compact"]);

    const written: string[] = [];
    const write = process.stderr.write;
    (process.stderr as any).write = (chunk: string) => (written.push(String(chunk)), true);
    try {
      const print = createMockOmp();
      register(print.pi);
      print.ctx.hasUI = false;
      print.invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION));
      expect(print.notifyCalls).toEqual([]);
    } finally {
      (process.stderr as any).write = write;
    }
    expect(written).toEqual(["omp-vcc: Too few messages to compact\n"]);
  });
});
