// The compaction hook on omp's own convertToLlm, the way index.ts binds it, for
// tests that drive the hook or the cut helpers without a running omp.
import { DEFAULT_BUDGETS, DEFAULT_SUMMARY_LIMITS } from "./window";
import { compileSummary } from "../../src/core/summarize";
import { toSummaryMessage } from "../../src/compaction/summary-input";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { createCompactionState, registerCompactionHook, type CompactionHost, type CompactionState } from "../../src/hooks/compaction";
import { createWindowState } from "../../src/hooks/window-limits";
import { testConfig } from "./binding";
import { hostNotes, type OwnCutCancelReason } from "../../src/compaction/plan";
import { core } from "../../src/core/lisp-core";
import type { CompactionStats } from "../../src/compaction/stats";
import { ompHost } from "../../src/hooks/omp-host";
import { bind, MANUAL_TRIGGER, OMP_HOST } from "../../src/host";
import type { CompactionReason } from "../../src/types";

/** omp's convertToLlm, as pi.pi.convertToLlm hands it to the hook. */
export const ompConvertToLlm = (messages: any[]): any[] => convertToLlm(messages);

/** omp, every compaction a manual one. */
export const testHost: CompactionHost = bind({ ...OMP_HOST, convertToLlm: ompConvertToLlm, triggerOf: () => MANUAL_TRIGGER }, testConfig);

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
  | { ok: false; reason: OwnCutCancelReason };

/** The brief's lines the core writes of these messages, through the hook's toSummaryMessage: what the summarizer gets of them. */
export const renderedBlocks = (messages: any[]): string[] =>
  compileSummary({ messages: messages.map((m) => toSummaryMessage(m, ompConvertToLlm)).filter((m) => m != null), limits: DEFAULT_SUMMARY_LIMITS })
    .state.brief.split("\n").filter((l) => l.trim() !== "");

/** One step of the core's cut (op cut) on these entries, on omp's convertToLlm. */
const cutStep = (branchEntries: any[], request: Record<string, unknown>) =>
  core({ op: "cut", branch: branchEntries, notes: hostNotes({ branchEntries, convert: ompConvertToLlm, sessionFile: undefined, indexById: undefined }), ...request });

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
    sendUserMessage: (...args: any[]) => pi.sendUserMessage?.(...args),
    sendMessage: (...args: any[]) => pi.sendMessage?.(...args),
    pi: { ...pi.pi, convertToLlm: ompConvertToLlm },
  };
  const state = createCompactionState();
  registerCompactionHook(bound, bind(ompHost(bound), testConfig), state, createWindowState());
  lastRegistered = {
    state,
    autoCompactionStart: (reason) =>
      auto.get("auto_compaction_start")?.({ type: "auto_compaction_start", reason, action: "context-full" }),
  };
  return lastRegistered;
};

/** Stats of the last compaction of the most recently registered hook. */
export const getLastCompactionStats = (): CompactionStats | null => lastRegistered?.state.lastStats ?? null;
