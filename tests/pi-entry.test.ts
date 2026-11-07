// The Pi entry (pi.ts) against a fake Pi extension API. pi.ts takes convertToLlm
// and getAgentDir from Pi's own package, so these run where Pi is installed
// (`bun run setup:pi`); tests/pi-host.test.ts runs the same entry inside a real Pi.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { assertRealPi, piInstalled } from "./support/pi";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { recordLearnedWindow } from "./support/window";



let dir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-pi-entry-"));
  for (const key of ["OMP_VCC_CONFIG_PATH", "PI_CODING_AGENT_DIR"]) saved[key] = process.env[key];
  process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
  // Pi's getAgentDir reads this: the learned-limits file lands here, never in ~/.pi.
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false }));
});

async function createPi(model: Record<string, unknown> = { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 }) {
  const { default: registerPi } = await import("../pi");
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools: any[] = [];
  const notices: string[] = [];
  const compactCalls: any[] = [];
  let entries: any[] = [];
  let usedTokens = 0;

  const ctx: any = {
    mode: "rpc",
    hasUI: true,
    ui: { notify: (msg: string) => notices.push(msg) },
    model,
    isIdle: () => true,
    getContextUsage: () => ({ tokens: usedTokens, contextWindow: model.contextWindow, percent: null }),
    sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionFile: () => undefined },
    // Pi's compact(): starts the compaction and returns; only the callbacks say it ended.
    compact: (options: any) => {
      compactCalls.push(options);
      setTimeout(() => options?.onComplete?.({}), 0);
    },
  };
  const fire = (name: string, event: any) => {
    let result: any;
    for (const h of handlers.get(name) ?? []) {
      const r = h({ type: name, ...event }, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  };
  const pi: any = {
    on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (name: string, c: any) => commands.set(name, c.handler),
    registerTool: (t: any) => tools.push(t),
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
  };
  registerPi(pi);
  /** Pi's session_before_compact: its trigger and its compaction settings ride along. */
  const beforeCompact = (event: Record<string, unknown>) =>
    fire("session_before_compact", {
      preparation: { previousSummary: undefined, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, tokensBefore: 5000, settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
      branchEntries: entries,
      signal: new AbortController().signal,
      ...event,
    });
  return {
    handlers, commands, tools, notices, compactCalls, ctx, fire, beforeCompact,
    setEntries: (e: any[]) => { entries = e; },
    setUsed: (n: number) => { usedTokens = n; },
    run: (name: string, args = "") => commands.get(name)!(args, ctx),
  };
}

let n = 0;
const entry = (message: any) => ({ id: `p${++n}`, type: "message", message: { timestamp: 0, ...message } });
const user = (t: string) => entry({ role: "user", content: t });
const assistant = (t: string) => entry({ role: "assistant", content: [{ type: "text", text: t }] });
const conversation = () => [
  user("First request: fix the login bug"), assistant("Looking into it."),
  user("Second request: also fix logout"), assistant("Both fixed."),
  user("Third request: write tests"), assistant("Tests written."),
];

describe.skipIf(!piInstalled())("Pi entry", () => {
  beforeAll(assertRealPi);
  test("registers the hook on Pi's events, the /pi-vcc commands and the tools, and nothing of omp's", async () => {
    const pi = await createPi();
    // No raw capture (Pi rewrites nothing in place) and no omp trigger tracking; the request hook leaves evicted turns out; a session starting carries the last one's named notes.
    expect([...pi.handlers.keys()].sort()).toEqual(["agent_settled", "context", "message_end", "session_before_compact", "session_compact", "session_start"]);
    expect([...pi.commands.keys()].sort()).toEqual(["pi-vcc", "pi-vcc-evict", "pi-vcc-pin", "pi-vcc-recall", "pi-vcc-unpin"]);
    expect(pi.tools.map((t: any) => t.name)).toEqual(["vcc_recall", "vcc_pin"]);
    // The tools name Pi's commands: vcc_pin told the agent the user pins with /omp-vcc-pin.
    const pin = pi.tools.find((t: any) => t.name === "vcc_pin");
    expect(pin.description).toContain("/pi-vcc-pin");
    expect(pin.description).not.toContain("omp-vcc");
  });

  test("the trigger is the one Pi's event carries, and the budgets are sized for Pi's own threshold", async () => {
    const pi = await createPi();
    pi.setEntries(conversation());
    const overflow = pi.beforeCompact({ reason: "overflow", willRetry: true });
    expect(overflow.compaction.details).toMatchObject({ reason: "overflow", willRetry: true });
    const threshold = pi.beforeCompact({ reason: "threshold", willRetry: false });
    expect(threshold.compaction.details).toMatchObject({ reason: "threshold", willRetry: false });
    // Pi compacts past window less reserveTokens: 200,000 - 16,384.
    expect(threshold.compaction.details.limits).toMatchObject({ contextWindow: 200_000, windowSource: "pi", trigger: 183_616 });
  });

  test("the summary reads the branch as Pi's context holds it: an omitted attempt and a redacted result", async () => {
    {
      const pi = await createPi();
      const attempt = assistant("A first attempt that Pi retried away");
      const call = entry({ role: "assistant", content: [{ type: "toolCall", id: "k1", name: "bash", arguments: { command: "cat .env" } }] });
      const result = entry({ role: "toolResult", toolCallId: "k1", toolName: "bash", content: [{ type: "text", text: "API_KEY=hunter2" }], isError: false });
      pi.setEntries([
        user("Zeroth request: read the env file"), attempt, call, result,
        { id: `p${++n}`, type: "context_edit", targetId: attempt.id, replacement: null },
        { id: `p${++n}`, type: "context_edit", targetId: result.id, replacement: { content: "[redacted by the user]" } },
        ...conversation(),
      ]);
      const summary: string = pi.beforeCompact({ reason: "threshold", willRetry: false }).compaction.summary;
      expect(summary).toContain("Zeroth request");
      expect(summary).not.toContain("hunter2");
      expect(summary).not.toContain("Pi retried away");
    }
  });

  test("/pi-vcc hands Pi the marker as customInstructions and waits for Pi's callback", async () => {
    const pi = await createPi();
    pi.setEntries(conversation());
    await pi.run("pi-vcc", "keep:1");
    expect(pi.compactCalls).toHaveLength(1);
    expect(pi.compactCalls[0].customInstructions).toContain("keep:1");
    // Pi's compact() returned at once; the command came back only after Pi's onComplete, which reports the outcome.
    expect(pi.notices).toEqual(["Compacted with omp-vcc"]);
    // The hook gets the marker from Pi's event, so it compacts with omp-vcc even when overriding is off.
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: false }));
    const result = pi.beforeCompact({ reason: "manual", willRetry: false, customInstructions: pi.compactCalls[0].customInstructions });
    expect(result?.compaction?.details?.compactor).toBe("omp-vcc");
  });

  test("past its own trigger on a model whose window Pi overestimates, omp-vcc compacts once Pi settles", async () => {
    const model = { provider: "local", id: "small-model", contextWindow: 128_000 };
    recordLearnedWindow(dirname(process.env.OMP_VCC_CONFIG_PATH!), "local/small-model", 32_768);
    const pi = await createPi(model);
    pi.setEntries(conversation());
    // Pi's reserve, once a compaction has carried it.
    pi.beforeCompact({ reason: "manual", willRetry: false });
    pi.setUsed(20_000);
    pi.fire("agent_settled", { aborted: false });
    await Bun.sleep(5);
    expect(pi.compactCalls).toHaveLength(1);
    expect(pi.notices.some((m) => m.includes("not the 128000 Pi uses") && m.includes("Pi's models.json"))).toBe(true);
    // Not after a run the user aborted.
    await Bun.sleep(5);
    pi.fire("agent_settled", { aborted: true });
    await Bun.sleep(5);
    expect(pi.compactCalls).toHaveLength(1);
  });
});
