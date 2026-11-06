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
import type { VccSettings } from "../core/settings";
import { calibrateCharsPerToken, DEFAULT_CHARS_PER_TOKEN, estimateMessageChars, estimateTokensFromChars } from "../core/token-estimate";
import { compactionBudgets } from "../core/window";
import { isRecovery, tell, type Binding } from "../host";
export type { CompactionTrigger } from "../host";
import { applyContextEdits } from "../core/context-edits";
import { modelKey } from "../core/model-limits";
import { observeCompaction, triggerFor, windowOf, type WindowState } from "./window-limits";
import { vccDetailsOf, type VccCompactionDetails } from "../details";
import { COMPACTOR } from "../names";
import type { CompactionReason } from "../types";
import {
  applyTailBudget,
  buildOwnCut,
  collectLiveMessages,
  keptChars,
  resolveSmartKeepUserTurns,
  runningTurnCut,
  wholeWindowCut,
  type OwnCutCancelReason,
} from "../compaction/cut";
import { assembleSummary } from "../compaction/assemble";
import { scheduleCompactionStatsNotify, type CompactionStats } from "../compaction/stats";

export { OMP_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";

/** What the compaction hook needs of its host. */
export type CompactionHost = Pick<Binding, "name" | "rule" | "convertToLlm" | "triggerOf" | "config">;

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

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "omp-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "omp-vcc: Too few messages to compact",
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
    if (!fromCommand && !settings.overrideDefaultCompaction) return;
    // Provider-level opt-out (#27): defer to the provider's own compaction
    // (e.g. a provider's remote compaction). Checked at call time because the
    // model can change mid-session via /model. Explicit /omp-vcc bypasses the
    // skip; undefined model never skips.
    const provider = ctx?.model?.provider;
    if (!fromCommand && typeof provider === "string" &&
        settings.skipForProviders.some((p) => p.toLowerCase() === provider.toLowerCase())) return;

    const { tokenEstimate, overheadTokens } = measureContext(branchEntries, preparation.tokensBefore, previousSummary);
    // Budgets from the model's real window and where the next compaction comes (core/window.ts).
    const window = windowOf(ctx?.model, host.name, host.config.dir());
    const key = modelKey(ctx?.model);
    observeCompaction(windows, window, key, reason, preparation.tokensBefore, rule.policyOf((preparation as { settings?: unknown }).settings));
    const trigger = triggerFor(window, windows, key, reason, preparation.tokensBefore, rule);
    const budgets = compactionBudgets(trigger, overheadTokens, settings.workingSet);
    const cutOptions = { charsPerToken: tokenEstimate.charsPerToken, skipCustomTypes: settings.skipCustomTypes, maxTokens: budgets.maxTailTokens };

    // Smart keep-tail: boost default keep when the tail is small.
    // Explicit keep:N from the user is always respected (resolver no-ops).
    const smartKeep = resolveSmartKeepUserTurns({
      branchEntries,
      requestedKeepUserTurns: keepUserTurns,
      smartKeepTail: settings.smartKeepTail,
      skipCustomTypes: settings.skipCustomTypes,
      charsPerToken: tokenEstimate.charsPerToken,
      minTokens: budgets.minTailTokens,
      maxTokens: budgets.maxTailTokens,
      convert,
    });
    let ownCut = buildOwnCut(convert, branchEntries, smartKeep.keepUserTurns, settings.skipCustomTypes);
    // Default path only: rescue autonomous / oversized-tail sessions with a
    // token-budget cut. Explicit keep:N is respected absolutely (no-op here).
    if (ownCut.ok && keepUserTurns === null) ownCut = applyTailBudget(convert, branchEntries, ownCut, cutOptions);
    // A recovery pass (an overflow, a cut-off reply) must shrink the context.
    // omp-vcc answers it itself: stepping aside hands it to the method omp picked
    // (snapcompact, handoff, server compaction, an LLM summary). What is kept and
    // still too big, omp's rescue shakes after the compaction commits.
    const recovering = !fromCommand && isRecovery({ reason, willRetry });
    // An automatic pass on a turn still running (its last message is a tool result:
    // omp compacts between the tool calls of one turn) whose live window has no
    // earlier user turn and fits the tail budget: the only cut left is compact-all,
    // which would summarize away the request and tool output the agent is working
    // from. A threshold or idle pass waits until the turn has ended; a recovery
    // pass keeps the turn's newest steps and summarizes the rest.
    if (
      ownCut.ok && ownCut.compactAll && ownCut.keepFallbackToCompactAll && !fromCommand
      && ownCut.messages[ownCut.messages.length - 1]?.role === "toolResult"
      && reason !== "manual"
    ) {
      if (!recovering) {
        dbg(settings, { deferredRunningTurn: true, compaction: { reason, willRetry }, liveMessages: ownCut.messages.length });
        return { cancel: true };
      }
      ownCut = runningTurnCut(convert, branchEntries, ownCut, cutOptions) ?? ownCut;
      dbg(settings, { runningTurnRecovery: true, compaction: { reason, willRetry }, budgetCut: ownCut.ok ? ownCut.budgetCut : undefined });
    }
    // One or two messages too big for the window: summarized whole on a recovery pass.
    if (!ownCut.ok && recovering && ownCut.reason === "too_few_live_messages") {
      ownCut = wholeWindowCut(convert, branchEntries, settings.skipCustomTypes) ?? ownCut;
    }
    if (!ownCut.ok) {
      const live = collectLiveMessages(branchEntries).map((m) => m.message.role);
      dbg(settings, {
        // Nothing live to summarize: no method of the host's can shrink it either, so a recovery pass is left to it.
        cancelled: !recovering,
        reason: ownCut.reason,
        compaction: { reason, willRetry },
        fromCommand,
        entries: branchEntries.length,
        liveRoles: live.length <= 30 ? live : [...live.slice(0, 10), "...", ...live.slice(-10)],
      });
      if (recovering) return;
      notify(ctx, REASON_MESSAGES[ownCut.reason]);
      return { cancel: true };
    }

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

    const assembled = assembleSummary({
      branchEntries,
      cut: ownCut,
      convert,
      sessionFile: (ctx as any)?.sessionManager?.getSessionFile?.(),
      indexById: globalIndexById,
      previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.edited],
        writtenFiles: [...preparation.fileOps.written],
      },
      settings,
      budgets,
      charsPerToken: tokenEstimate.charsPerToken,
    });
    const { compiled, growth } = assembled;
    const summary = compiled.text;
    const { firstKeptEntryId } = ownCut;

    // Growth guard: a compaction that leaves the context bigger is not written,
    // and a manual pass says why (an automatic one would say so on every turn
    // until the prefix grows). Recovering, it is written when it keeps part of
    // the window: what overflows is that kept part, and omp's rescue shakes its
    // oversized tool output once this commits. When even summarizing the whole
    // window grows the context, what fills it is what no compaction removes.
    if (growth.grows) {
      dbg(settings, { growthGuard: growth, writtenForRescue: recovering && !ownCut.compactAll, compaction: { reason, willRetry }, summarized: ownCut.messages.length });
      if (!recovering || ownCut.compactAll) {
        state.lastStats = null;
        if (recovering) {
          notify(ctx, `omp-vcc: Not compacted: the ${ownCut.messages.length} messages left are smaller than a summary of them; the context is full of what no compaction removes (the system prompt and tools).`);
        } else if (reason === "manual") {
          const more = ownCut.compactAll ? "" : " keep:0 summarizes everything.";
          notify(ctx, `omp-vcc: Not compacted: the summary would be ${growth.netChars} chars larger than the ${ownCut.messages.length} messages it replaces.${more}`);
        }
        return { cancel: true };
      }
    }

    const keptIdx = branchEntries.findIndex((e: any) => e.id === firstKeptEntryId);
    const kept = keptIdx >= 0 ? branchEntries.slice(keptIdx) : [];
    const stats: CompactionStats = {
      summarized: assembled.summarized,
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      keptTokensEst: estimateTokensFromChars(keptChars(kept), tokenEstimate.charsPerToken),
      smartKeepAdjusted: smartKeep.smartAdjusted,
      budgetCut: ownCut.budgetCut,
    };
    state.lastStats = stats;
    state.pendingFollowUpPrompt = followUpPrompt;
    state.lastCompactFromCommand = fromCommand;

    dbg(settings, {
      compaction: { reason, willRetry },
      budgetCut: ownCut.budgetCut,
      summarized: assembled.summarized,
      firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      tokenEstimate,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: compiled.sections,
    });

    const details: VccCompactionDetails = {
      compactor: COMPACTOR,
      // version 2 = refs are session-global (recall index space); version 1
      // summaries carried window-relative refs (issue #28).
      version: 2,
      sections: compiled.sections,
      summaryState: compiled.state,
      sourceMessageCount: assembled.summarized,
      previousSummaryUsed: Boolean(previousSummary),
      reason,
      willRetry,
      ...(assembled.historyIndex ? { historyIndex: assembled.historyIndex } : {}),
      ...(assembled.workingSet ? { workingSet: assembled.workingSet } : {}),
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
    scheduleCompactionStatsNotify(ctx, stats);
    // omp resumes an interrupted run by itself after automatic maintenance
    // (compaction.autoContinue); only a /compact follow-up prompt is sent here.
    if (followUpPrompt) {
      try {
        await pi.sendUserMessage(followUpPrompt);
      } catch {}
    }
  });
};
