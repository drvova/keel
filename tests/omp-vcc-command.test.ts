// /omp-vcc's argument handling and what it reports, against a fake omp API.
// tests/omp-entry.test.ts covers the command wired to the hook through index.ts.
import { describe, expect, test } from "bun:test";
import { registerOmpVccCommand } from "../src/commands/omp-vcc";
import { createCompactionState, OMP_VCC_COMPACT_INSTRUCTION } from "../src/hooks/compaction";

type CompactOptions = {
  suppressContinuation?: boolean;
  onComplete?: () => void;
  onError?: (err: Error) => void;
};

function createHarness(sendUserMessage?: (content: string | unknown[]) => unknown, mode: "tui" | "rpc" = "rpc") {
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

  registerOmpVccCommand(pi, state);

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
    expect(compactCalls[0].instructions).toBe(OMP_VCC_COMPACT_INSTRUCTION);
    expect(state.pendingManualInstructions).toBeNull();
  });

  test("parses keep token at the start of args and strips it from the prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("keep:3   continue  ");

    expect(compactCalls[0].instructions).toBe(`${OMP_VCC_COMPACT_INSTRUCTION} keep:3`);
    compactCalls[0].onComplete?.();
    expect(userMessages).toEqual(["continue"]);
  });

  test("parses keep token at the end of args and strips it from the prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("  continue   keep:2");

    expect(compactCalls[0].instructions).toBe(`${OMP_VCC_COMPACT_INSTRUCTION} keep:2`);
    compactCalls[0].onComplete?.();
    expect(userMessages).toEqual(["continue"]);
  });

  test("parses a lone keep token without sending a follow-up prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("keep:4");

    expect(compactCalls[0].instructions).toBe(`${OMP_VCC_COMPACT_INSTRUCTION} keep:4`);
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

    expect(() => compactCalls[0].onComplete?.()).not.toThrow();
    await Promise.resolve();
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
    expect(notifyCalls).toEqual([{ msg: "Nothing to compact", level: "warning" }]);
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

  test("normalizes huge keep tokens to a safe integer instruction", async () => {
    const { invoke, compactCalls } = createHarness();

    await invoke("keep:999999999999999999999 continue");

    expect(compactCalls[0].instructions).toBe(`${OMP_VCC_COMPACT_INSTRUCTION} keep:${Number.MAX_SAFE_INTEGER}`);
  });
});
