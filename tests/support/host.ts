// The compaction hook on omp's own convertToLlm, the way index.ts binds it, for
// tests that drive the hook or the cut helpers without a running omp.
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
  applyTailBudget as applyTailBudgetFor,
  buildOwnCut as buildOwnCutFor,
  createCompactionState,
  registerCompactionHook,
  resolveSmartKeepUserTurns as resolveSmartKeepFor,
  toSummaryMessage,
  type CompactionHost,
  type CompactionState,
  type CompactionStats,
  type OwnCutResult,
  type ResolveSmartKeepOptions,
} from "../../src/hooks/compaction";
import { createOmpCompactionHost, trackOmpCompactionTrigger } from "../../src/hooks/omp-host";
import { normalize } from "../../src/core/normalize";
import type { CompactionReason } from "../../src/types";

/** omp's convertToLlm, as pi.pi.convertToLlm hands it to the hook. */
export const ompConvertToLlm = (messages: any[]): any[] => convertToLlm(messages);

export const testHost: CompactionHost = { convertToLlm: ompConvertToLlm };

/** The blocks the summarizer gets for these messages: the hook's toSummaryMessage, then normalize. */
export const renderedBlocks = (messages: any[]) =>
  normalize(messages.map((m) => toSummaryMessage(m, testHost)).filter((m) => m != null));

export const buildOwnCut = (branchEntries: any[], keepUserTurns?: number, skipCustomTypes?: readonly string[]): OwnCutResult =>
  buildOwnCutFor(testHost, branchEntries, keepUserTurns, skipCustomTypes);

export const applyTailBudget = (
  branchEntries: any[],
  cut: OwnCutResult,
  opts?: Parameters<typeof applyTailBudgetFor>[3],
): OwnCutResult => applyTailBudgetFor(testHost, branchEntries, cut, opts);

export const resolveSmartKeepUserTurns = (opts: Omit<ResolveSmartKeepOptions, "host">) =>
  resolveSmartKeepFor({ ...opts, host: testHost });

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
    sendUserMessage: (...args: any[]) => pi.sendUserMessage?.(...args),
    sendMessage: (...args: any[]) => pi.sendMessage?.(...args),
    pi: { ...pi.pi, convertToLlm: ompConvertToLlm },
  };
  const state = createCompactionState();
  registerCompactionHook(bound, createOmpCompactionHost(bound, trackOmpCompactionTrigger(bound)), state);
  lastRegistered = {
    state,
    autoCompactionStart: (reason) =>
      auto.get("auto_compaction_start")?.({ type: "auto_compaction_start", reason, action: "context-full" }),
  };
  return lastRegistered;
};

/** Stats of the last compaction of the most recently registered hook. */
export const getLastCompactionStats = (): CompactionStats | null => lastRegistered?.state.lastStats ?? null;
