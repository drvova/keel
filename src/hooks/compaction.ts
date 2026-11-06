// The compaction hook, shared by both hosts: the event in, the compaction (or
// a cancel) out. Where to cut is src/compaction/cut.ts, what is written
// src/compaction/assemble.ts. It imports no host package at runtime: the
// host's own functions and rules arrive through a CompactionHost (omp:
// src/hooks/omp-host.ts; Pi: pi.ts), so `bun build --packages external` stays
// on node builtins.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { writeFileSync } from "fs";
import { indexById, readEntries } from "../core/session-file";
import { parseInstructions } from "../core/compact-args";
import { handlesHostCompactions, type VccSettings } from "../core/settings";
import { calibrateCharsPerToken, DEFAULT_CHARS_PER_TOKEN, estimateMessageChars, estimateTokensFromChars } from "../core/token-estimate";
import { compactionBudgets, triggerFor } from "../core/window";
import { isRecovery, tell, type Binding } from "../host";
import { applyContextEdits } from "../core/context-edits";
import { modelKey, recordHostPolicy } from "../core/model-limits";
import type { WindowState } from "./window-limits";
import { vccDetailsOf, type VccCompactionDetails } from "../details";
import { COMPACTOR } from "../names";
import { collectLiveMessages } from "../compaction/cut";
import { planCompaction } from "../compaction/plan";
import { tellCompactionStats, type CompactionStats } from "../compaction/stats";

/** What the compaction hook needs of its host. */
export type CompactionHost = Pick<Binding, "rule" | "convertToLlm" | "triggerOf" | "config" | "window">;

/** Per-registration state. omp binds the factory again for every subagent, so it gets one per binding. */
export interface CompactionState {
  lastStats: CompactionStats | null;
  /** The last compaction came from /omp-vcc, which reports its own outcome. */
  lastCompactFromCommand: boolean;
  pendingFollowUpPrompt: string | null;
  /**
   * The /omp-vcc marker for the manual compaction the command is starting:
   * omp's ctx.compact() cannot carry instructions together with callbacks. The
   * hook reads it for a manual pass that arrives without instructions.
   */
  pendingManualInstructions: string | null;
  /** Why the hook last cancelled a compaction, for /omp-vcc to report where omp shows no notifications. */
  lastCancelNotice: string | null;
}

export const createCompactionState = (): CompactionState => ({
  lastStats: null,
  lastCompactFromCommand: false,
  pendingFollowUpPrompt: null,
  pendingManualInstructions: null,
  lastCancelNotice: null,
});


/** With the `debug` setting on, each compaction's decisions are written here. */
const DEBUG_PATH = "/tmp/omp-vcc-debug.json";

const dbg = (settings: VccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  // A debug write must never break a compaction.
  try { writeFileSync(DEBUG_PATH, JSON.stringify(data, null, 2)); } catch {}
};

/**
 * Prompt tokens of the session's first request less what its messages account
 * for: the system prompt and tool schemas every request carries. Undefined when
 * no request recorded its usage.
 */
const measuredOverheadTokens = (branchEntries: any[]): number | undefined => {
  let chars = 0;
  for (const e of branchEntries) {
    if (e?.type !== "message" || !e.message) continue;
    const m = e.message;
    const u = m.role === "assistant" ? m.usage : undefined;
    const prompt = u ? (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) : 0;
    if (prompt > 0) return Math.max(0, prompt - estimateTokensFromChars(chars, DEFAULT_CHARS_PER_TOKEN));
    chars += estimateMessageChars(m);
  }
  return undefined;
};

/**
 * The context as a compaction sizes it: chars per token calibrated on the
 * messages, and what a compaction cannot remove (system prompt, tool schemas).
 * The session's first request measured that: its prompt held little else.
 * Without one, the provider-counted context less what the messages account for
 * at 4 chars/token, which overstates it for dense text.
 */
const measureContext = (branchEntries: any[], tokensBefore: number, previousSummary: string | undefined) => {
  const messageChars = collectLiveMessages(branchEntries).reduce((sum, m) => sum + estimateMessageChars(m.message), 0);
  const contentChars = messageChars + (previousSummary?.length ?? 0);
  const measured = measuredOverheadTokens(branchEntries);
  // Calibrated on the messages alone where the overhead is known, so a summary's
  // token budget maps to the chars the messages actually take.
  const tokenEstimate = calibrateCharsPerToken(contentChars, measured !== undefined && tokensBefore > measured ? tokensBefore - measured : tokensBefore);
  const overheadTokens = measured
    ?? (tokensBefore > 0 ? Math.max(0, tokensBefore - estimateTokensFromChars(contentChars, DEFAULT_CHARS_PER_TOKEN)) : 0);
  return { tokenEstimate, overheadTokens };
};


/**
 * omp binds the factory once per session (subagents too), so each binding
 * passes its own `state`.
 */
export const registerCompactionHook = (
  pi: ExtensionAPI,
  host: CompactionHost,
  state: CompactionState,
  windows: WindowState,
) => {
  const convert = host.convertToLlm;
  const notify = (ctx: any, message: string) => {
    // /omp-vcc reads it to know the user was told why.
    state.lastCancelNotice = message;
    // The UI may be gone (a closed session).
    try { tell(ctx, message, "warning"); } catch {}
  };

  pi.on("session_before_compact", (event, ctx) => {
    const { preparation } = event;
    // What the context holds: Pi's context edits applied, as Pi applies them
    // (core/context-edits.ts). An omp branch has none and comes back as it is.
    const branchEntries = applyContextEdits(event.branchEntries as any[]) as any[];
    const { rule } = host;
    // Read on every run: omp's tracker forgets its trigger once read.
    const hostTrigger = host.triggerOf(event);
    const { reason, willRetry } = windows.selfTrigger ?? hostTrigger;
    const customInstructions = event.customInstructions
      ?? (reason === "manual" ? state.pendingManualInstructions ?? undefined : undefined);
    const settings = host.config.load();
    const previousSummary = typeof preparation.previousSummary === "string" ? preparation.previousSummary : undefined;

    const { fromCommand, keepUserTurns, followUpPrompt } = parseInstructions(customInstructions);
    state.pendingFollowUpPrompt = null;
    if (!fromCommand && !handlesHostCompactions(settings, ctx?.model?.provider)) return;

    const { tokenEstimate, overheadTokens } = measureContext(branchEntries, preparation.tokensBefore, previousSummary);
    // Budgets from the model's real window and where the next compaction comes (core/window.ts).
    const window = host.window(ctx?.model);
    const key = modelKey(ctx?.model);
    const policy = rule.policyOf((preparation as { settings?: unknown }).settings);
    // Kept beside the learned window, for the compaction omp-vcc starts in the host's stead (window-limits.ts).
    recordHostPolicy(host.config.dir(), key, policy);
    // A pass that must shrink the context: an overflow, a cut-off reply, one the host retries.
    const recovering = !fromCommand && isRecovery({ reason, willRetry });
    const trigger = triggerFor(window.effective, recovering, preparation.tokensBefore, policy, rule);
    // A pass omp-vcc started itself went by the policy as last recorded; this
    // one carries the current policy, which may since say no: compaction off,
    // or a trigger the context (measured as the end-of-run check measured it) is under.
    if (windows.selfTrigger) {
      const used = ctx?.getContextUsage?.()?.tokens;
      if (!rule.autoCompacts(policy) || (typeof used === "number" && trigger !== undefined && used < trigger)) return { cancel: true };
    }
    const budgets = compactionBudgets(trigger, overheadTokens, settings.workingSet);
    let globalIndexById: Map<string, number> | undefined;
    // Recall numbers messages across the whole session file (all windows, all
    // branches): the host's in-memory tree, else the file.
    try {
      const sm = (ctx as any)?.sessionManager;
      const all = sm?.getEntries?.();
      const sf = sm?.getSessionFile?.();
      const entries = Array.isArray(all) ? all : typeof sf === "string" && sf ? readEntries(sf) : undefined;
      if (entries) globalIndexById = indexById(entries);
    } catch {
      globalIndexById = undefined;
    }

    const plan = planCompaction({
      branchEntries,
      convert,
      keepUserTurns,
      fromCommand,
      reason,
      recovering,
      settings,
      budgets,
      charsPerToken: tokenEstimate.charsPerToken,
      sessionFile: (ctx as any)?.sessionManager?.getSessionFile?.(),
      indexById: globalIndexById,
      previousSummary,
      fileOps: { read: [...preparation.fileOps.read], changed: [...preparation.fileOps.edited, ...preparation.fileOps.written] },
    });

    if (plan.kind === "step_aside") {
      dbg(settings, { cancelled: false, reason: plan.cutReason, compaction: { reason, willRetry }, fromCommand, entries: branchEntries.length, liveRoles: plan.liveRoles });
      return;
    }
    if (plan.kind === "cancel") {
      if (plan.why === "running_turn") dbg(settings, { deferredRunningTurn: true, compaction: { reason, willRetry }, liveMessages: plan.summarized });
      else if (plan.why === "no_cut") dbg(settings, { cancelled: true, reason: plan.cutReason, compaction: { reason, willRetry }, fromCommand, entries: branchEntries.length, liveRoles: plan.liveRoles });
      else {
        dbg(settings, { growthGuard: plan.growth, writtenForRescue: false, compaction: { reason, willRetry }, summarized: plan.summarized });
        state.lastStats = null;
      }
      if (plan.notice) notify(ctx, plan.notice);
      return { cancel: true };
    }

    const summary = plan.summary;
    const { firstKeptEntryId } = plan;
    if (plan.runningTurnRecovery) dbg(settings, { runningTurnRecovery: true, compaction: { reason, willRetry }, budgetCut: plan.budgetCut });
    if (plan.writtenForRescue) dbg(settings, { growthGuard: plan.writtenForRescue.growth, writtenForRescue: true, compaction: { reason, willRetry }, summarized: plan.writtenForRescue.summarized });
    state.lastStats = plan.stats;
    state.pendingFollowUpPrompt = followUpPrompt;
    state.lastCompactFromCommand = fromCommand;

    dbg(settings, {
      compaction: { reason, willRetry },
      budgetCut: plan.budgetCut,
      summarized: plan.summarized,
      firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      tokenEstimate,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: plan.sections,
    });

    const details: VccCompactionDetails = {
      compactor: COMPACTOR,
      // version 2 = refs are session-global (recall index space); version 1
      // summaries carried window-relative refs (issue #28).
      version: 2,
      sections: plan.sections,
      summaryState: plan.summaryState as VccCompactionDetails["summaryState"],
      sourceMessageCount: plan.summarized,
      previousSummaryUsed: Boolean(previousSummary),
      reason,
      willRetry,
      ...(plan.historyIndex ? { historyIndex: plan.historyIndex as VccCompactionDetails["historyIndex"] } : {}),
      ...(plan.workingSet ? { workingSet: plan.workingSet } : {}),
      // What the budgets were sized from, for debugging a compaction that kept too much or too little.
      limits: {
        ...(window.effective ? { contextWindow: window.effective, windowSource: window.source } : {}),
        ...(trigger ? { trigger } : {}),
        ...(overheadTokens ? { overheadTokens } : {}),
        maxTailTokens: budgets.maxTailTokens,
        briefCeilingTokens: budgets.briefCeilingTokens,
        ...(budgets.summaryScale !== 1 ? { summaryScale: budgets.summaryScale } : {}),
        workingSetTokens: budgets.workingSetTokens,
      },
    };

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  // Fire success toast for /compact and automatic compactions (delayed to let the
  // UI settle). /omp-vcc reports through its own onComplete callback.
  pi.on("session_compact", async (event, ctx) => {
    if (!event.fromExtension) return;
    // Another compaction extension can win even when omp-vcc also returned a
    // result, so read the persisted entry rather than lifecycle state: omp-vcc
    // stamps its compactor, reason and willRetry on its own details.
    const details = vccDetailsOf(event.compactionEntry?.details);
    if (!details) return;
    const followUpPrompt = state.pendingFollowUpPrompt;
    state.pendingFollowUpPrompt = null;
    if (state.lastCompactFromCommand) return;
    // omp retries the turn itself after an overflow or a cut-off reply.
    if (details.willRetry) return;
    const stats = state.lastStats;
    if (!stats) return;
    tellCompactionStats(ctx, stats);
    // omp resumes an interrupted run by itself after automatic maintenance
    // (compaction.autoContinue); only a /compact follow-up prompt is sent here.
    if (followUpPrompt) {
      try {
        await pi.sendUserMessage(followUpPrompt);
      } catch {}
    }
  });
};
