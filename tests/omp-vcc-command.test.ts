// /omp-vcc's argument handling and what it reports, against a fake omp API.
// tests/omp-entry.test.ts covers the command wired to the hook through index.ts.
import { OMP_HOST } from "../src/host";
import { describe, expect, test } from "bun:test";
import { registerOmpVccCommand } from "../src/commands/omp-vcc";
import { createCompactionState } from "../src/hooks/compaction";
import { COMPACT_INSTRUCTION } from "../src/names";

type CompactOptions = {
  suppressContinuation?: boolean;
  onComplete?: () => void;
  onError?: (err: Error) => void;
};

function createHarness(sendUserMessage?: (content: string | unknown[]) => unknown, mode: "tui" | "rpc" | "print" = "rpc", branch: Array<{ type: string }> = []) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const compactCalls: Array<CompactOptions & { instructions: string | null }> = [];
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const userMessages: Array<string | unknown[]> = [];
  const state = createCompactionState();

  const pi = {
    registerCommand: (name: string, command: { handler: typeof handler }) => {
      expect(name).toBe("omp-vcc");
      handler = command.handler;
    },
    sendUserMessage: sendUserMessage ?? ((content: string | unknown[]) => {
      userMessages.push(content);
    }),
  } as any;

  const ctx = {
    mode,
    // omp's print and json modes install a no-op UI.
    hasUI: mode !== "print",
    sessionManager: { getBranch: () => branch },
    // omp's ctx.compact(options): the marker reaches the hook through state, read here
    // while the call is in flight.
    compact: async (options: CompactOptions) => {
      compactCalls.push({ ...options, instructions: state.pendingManualInstructions });
    },
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  };

  registerOmpVccCommand(pi, state, OMP_HOST);

  return {
    invoke: async (args = "") => handler!(args, ctx),
    compactCalls,
    notifyCalls,
    userMessages,
    state,
  };
}

describe("/omp-vcc", () => {
  test("hands the hook the omp-vcc marker for the pass it starts, then clears it", async () => {
    const { invoke, compactCalls, state } = createHarness();

    await invoke();

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0].instructions).toBe(COMPACT_INSTRUCTION);
    expect(state.pendingManualInstructions).toBeNull();
  });

  test("parses keep token at the start of args and strips it from the prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("keep:3   continue  ");

    expect(compactCalls[0].instructions).toBe(`${COMPACT_INSTRUCTION} keep:3`);
    compactCalls[0].onComplete?.();
    expect(userMessages).toEqual(["continue"]);
  });

  test("parses keep token at the end of args and strips it from the prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("  continue   keep:2");

    expect(compactCalls[0].instructions).toBe(`${COMPACT_INSTRUCTION} keep:2`);
    compactCalls[0].onComplete?.();
    expect(userMessages).toEqual(["continue"]);
  });

  test("parses a lone keep token without sending a follow-up prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("keep:4");

    expect(compactCalls[0].instructions).toBe(`${COMPACT_INSTRUCTION} keep:4`);
    expect(compactCalls[0].suppressContinuation).toBeUndefined();
    compactCalls[0].onComplete?.();
    expect(userMessages).toHaveLength(0);
  });

  test("a trailing prompt is sent after a successful compaction, in place of omp's resume", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("  continue  ");

    expect(compactCalls[0].suppressContinuation).toBe(true);
    expect(userMessages).toHaveLength(0);
    compactCalls[0].onComplete?.();
    expect(userMessages).toEqual(["continue"]);
  });

  test("handles rejected follow-up send without throwing", async () => {
    const { invoke, compactCalls } = createHarness(() => Promise.reject(new Error("send failed")));

    await invoke("continue");

    // Called outside expect(): bun:test fails a test on an unhandled rejection
    // after a turn of the event loop, but not one raised inside expect(fn).toThrow.
    compactCalls[0].onComplete?.();
    await Bun.sleep(0);
  });

  test("skips follow-up when trailing prompt is empty", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("   ");
    compactCalls[0].onComplete?.();

    expect(userMessages).toHaveLength(0);
  });

  test("without stats from the hook, it still says the compaction happened", async () => {
    const { invoke, compactCalls, notifyCalls } = createHarness();

    await invoke();
    compactCalls[0].onComplete?.();

    expect(notifyCalls).toEqual([{ msg: "Compacted with omp-vcc", level: "info" }]);
  });

  test("does not send trailing prompt on compaction error", async () => {
    const { invoke, compactCalls, userMessages, notifyCalls } = createHarness();

    await invoke("continue");
    compactCalls[0].onError?.(new Error("Already compacted"));

    expect(userMessages).toHaveLength(0);
    expect(notifyCalls).toEqual([{ msg: "Nothing to compact: the session was just compacted.", level: "warning" }]);
  });

  test("explains omp's 'session too small' instead of reporting a failure", async () => {
    const { invoke, compactCalls, notifyCalls } = createHarness();

    await invoke("keep:0");
    compactCalls[0].onError?.(new Error("Nothing to compact (session too small)"));

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("compaction.keepRecentTokens in omp settings");
    expect(notifyCalls[0].msg).not.toContain("failed");
  });

  test("print mode, where omp drops notify: the outcome goes to stderr, stdout stays the model's", async () => {
    const written: string[] = [];
    const write = process.stderr.write;
    (process.stderr as any).write = (chunk: string) => (written.push(String(chunk)), true);
    try {
      const { invoke, compactCalls, notifyCalls, state } = createHarness(undefined, "print");
      await invoke();
      compactCalls[0].onError?.(new Error("Nothing to compact (session too small)"));
      await invoke();
      state.lastStats = { summarized: 4, keptUserTurns: 1, totalUserTurns: 2, keptTokensEst: 120 };
      compactCalls[1].onComplete?.();
      expect(notifyCalls).toEqual([]);
      expect(written[0]).toStartWith("Nothing to compact yet:");
      expect(written[1]).toBe("omp-vcc: kept 1/2 turns, ~120 tok (summarized 4).\n");
    } finally {
      (process.stderr as any).write = write;
    }
  });

  // Seen with a real model: right after an automatic compaction, /omp-vcc blamed a short session.
  test("after a compaction, 'nothing to compact' says what is left is what came after it", async () => {
    const { invoke, compactCalls, notifyCalls } = createHarness(undefined, "rpc", [{ type: "message" }, { type: "compaction" }, { type: "message" }]);
    await invoke();
    compactCalls[0].onError?.(new Error("Nothing to compact (session too small)"));
    expect(notifyCalls[0].msg).toStartWith("Nothing to compact yet: what came after the last compaction still fits");
    // After omp's /clear the earlier compaction no longer counts.
    const cleared = createHarness(undefined, "rpc", [{ type: "compaction" }, { type: "reset_boundary" }, { type: "message" }]);
    await cleared.invoke();
    cleared.compactCalls[0].onError?.(new Error("Nothing to compact (session too small)"));
    expect(cleared.notifyCalls[0].msg).toStartWith("Nothing to compact yet: the whole session still fits");
  });

  test("when omp-vcc's hook cancelled, the command adds nothing: the hook told the user why", async () => {
    const written: string[] = [];
    const write = process.stderr.write;
    (process.stderr as any).write = (chunk: string) => (written.push(String(chunk)), true);
    try {
      const print = createHarness(undefined, "print");
      await print.invoke();
      print.state.lastCancelNotice = "omp-vcc: Too few messages to compact";
      print.compactCalls[0].onError?.(new Error("Compaction cancelled"));
      expect(written).toEqual([]);
    } finally {
      (process.stderr as any).write = write;
    }
    const rpc = createHarness(undefined, "rpc");
    await rpc.invoke();
    rpc.state.lastCancelNotice = "omp-vcc: Too few messages to compact";
    rpc.compactCalls[0].onError?.(new Error("Compaction cancelled"));
    expect(rpc.notifyCalls).toEqual([]);
  });

  test("normalizes huge keep tokens to a safe integer instruction", async () => {
    const { invoke, compactCalls } = createHarness();

    await invoke("keep:999999999999999999999 continue");

    expect(compactCalls[0].instructions).toBe(`${COMPACT_INSTRUCTION} keep:${Number.MAX_SAFE_INTEGER}`);
  });
});
