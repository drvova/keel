// The compaction hook on omp's own convertToLlm, the way index.ts binds it, for
// tests that drive the hook or the cut helpers without a running omp.
import { DEFAULT_BUDGETS } from "./window";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { createCompactionState, registerCompaction, type CompactionState } from "../../src/compaction";
import { testConfig } from "./binding";
import { core } from "../../src/core";
import { ompHost, type CompactionReason } from "../../src/host";

/** omp's convertToLlm, as pi.pi.convertToLlm hands it to the hook. */
export const ompConvertToLlm = (messages: any[]): any[] => convertToLlm(messages);


/** Where a compaction cuts, as the core's cut has it (lisp/src/compaction.lisp). */
export type OwnCutResult =
  | {
      ok: true;
      messages: any[];
      selectedIds: string[];
      firstKeptEntryId: string;
      compactAll: boolean;
      keptUserTurns: number;
      totalUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: "final_reply" | "running_turn" | "no_anchor" | "oversized_tail";
    }
  | { ok: false; reason: "no_live_messages" | "too_few_live_messages" };

/** What omp's convertToLlm makes of each message, as the hook hands it to the core (it converts one at a time). */
export const convertEach = (messages: unknown[]): unknown[][] => messages.map((m) => {
  try { return ompConvertToLlm([m]); } catch { return []; }
});

/** A request to the core that first asks for what the host's convertToLlm makes of messages (op cut, op compact): asked, converted, asked again. */
export const withConversions = (request: Record<string, unknown>): Record<string, any> => {
  const first = core(request);
  return first.kind === "convert" ? core({ ...request, converted: convertEach(first.messages as unknown[]) }) : first;
};

/** One step of the core's cut (op cut) on these entries, on omp's convertToLlm. */
const cutStep = (branchEntries: any[], request: Record<string, unknown>) => withConversions({ op: "cut", branchEntries, ...request });

export const buildOwnCut = (branchEntries: any[], keepUserTurns?: number, skipCustomTypes: readonly string[] = []): OwnCutResult =>
  cutStep(branchEntries, { action: "own", keep: keepUserTurns ?? 1, skip: skipCustomTypes }).cut;

/** The tail functions at a ~128K window's budgets unless a test sets its own. */
export const applyTailBudget = (
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens?: number; charsPerToken?: number; skipCustomTypes?: readonly string[] } = {},
): OwnCutResult =>
  cutStep(branchEntries, { action: "tail-budget", cut, maxTokens: opts.maxTokens ?? DEFAULT_BUDGETS.maxTailTokens, charsPerToken: opts.charsPerToken, skip: opts.skipCustomTypes ?? [] }).cut;

export const resolveSmartKeepUserTurns = (opts: {
  branchEntries: any[];
  requestedKeepUserTurns: number | null;
  smartKeepTail: boolean;
  skipCustomTypes: readonly string[];
  minTokens?: number;
  maxTokens?: number;
  charsPerToken?: number;
}): { keepUserTurns: number; smartAdjusted: boolean } => {
  const r = cutStep(opts.branchEntries, {
    action: "smart-keep", requested: opts.requestedKeepUserTurns, smart: opts.smartKeepTail, skip: opts.skipCustomTypes,
    minTokens: opts.minTokens ?? DEFAULT_BUDGETS.minTailTokens, maxTokens: opts.maxTokens ?? DEFAULT_BUDGETS.maxTailTokens, charsPerToken: opts.charsPerToken,
  });
  return { keepUserTurns: r.keep, smartAdjusted: r.adjusted };
};

export interface RegisteredHook {
  state: CompactionState;
  /** What omp emits right before the hook for an automatic pass. */
  autoCompactionStart: (reason: Exclude<CompactionReason, "manual">) => void;
}

let lastRegistered: RegisteredHook | undefined;

/**
 * Register the hook on a fake omp API the way index.ts does: omp's
 * convertToLlm through pi.pi, the trigger from auto_compaction_start, a fresh
 * state. auto_compaction_* handlers stay here (see autoCompactionStart); every
 * other `on` goes to the fake's own.
 */
export const registerHook = (pi: any): RegisteredHook => {
  const auto = new Map<string, (event: any) => void>();
  const bound = {
    ...pi,
    on: (name: string, handler: any) => (name.startsWith("auto_compaction_") ? auto.set(name, handler) : pi.on(name, handler)),
    registerCommand: (...args: any[]) => pi.registerCommand?.(...args),
    sendUserMessage: (...args: any[]) => pi.sendUserMessage?.(...args),
    sendMessage: (...args: any[]) => pi.sendMessage?.(...args),
    pi: { ...pi.pi, convertToLlm: ompConvertToLlm },
  };
  const state = createCompactionState();
  registerCompaction(bound, { ...ompHost(bound), config: testConfig }, state);
  lastRegistered = {
    state,
    autoCompactionStart: (reason) =>
      auto.get("auto_compaction_start")?.({ type: "auto_compaction_start", reason, action: "context-full" }),
  };
  return lastRegistered;
};

/** The outcome line of the last compaction the most recently registered hook wrote. */
export const getLastCompactionStats = (): string | null => lastRegistered?.state.written?.statsLine ?? null;
