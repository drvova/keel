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
import { isRecovery, tell, type Binding } from "../host";
import { keepHostPolicy } from "../core/model-limits";
import type { WindowState } from "./window-limits";
import { vccDetailsOf } from "../details";
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
    // As the host has it: the plan reads it through Pi's context edits (core/context-edits.ts).
    const branchEntries = event.branchEntries as any[];
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

    const window = host.window(ctx?.model);
    // A pass that must shrink the context: an overflow, a cut-off reply, one the host retries.
    const recovering = !fromCommand && isRecovery({ reason, willRetry });
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
      rule,
      window: window.effective,
      windowSource: window.source,
      willRetry,
      tokensBefore: preparation.tokensBefore,
      hostSettings: (preparation as { settings?: unknown }).settings,
      // A pass omp-vcc started itself went by the policy as last recorded; this
      // one carries the current policy, which may since say no.
      ...(windows.selfTrigger ? { selfStarted: { usedTokens: ctx?.getContextUsage?.()?.tokens } } : {}),
      sessionFile: (ctx as any)?.sessionManager?.getSessionFile?.(),
      indexById: globalIndexById,
      previousSummary,
      fileOps: { read: [...preparation.fileOps.read], changed: [...preparation.fileOps.edited, ...preparation.fileOps.written] },
    });

    const { policy, trigger, overheadTokens, tokenEstimate, budgets } = plan.sizing;
    // Kept beside the learned window, for the compaction omp-vcc starts in the host's stead (window-limits.ts).
    keepHostPolicy(host.config.dir(), ctx?.model, policy);
    if (plan.kind === "step_aside") {
      dbg(settings, { cancelled: false, reason: plan.cutReason, compaction: { reason, willRetry }, fromCommand, entries: branchEntries.length, liveRoles: plan.liveRoles });
      return;
    }
    if (plan.kind === "cancel") {
      if (plan.why === "policy") return { cancel: true };
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

    const { details } = plan;

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
