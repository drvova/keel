// What a compaction writes once the cut is chosen: the summary (with
// [History Index], [Pinned Notes] and [Working Set]) and whether it is worth
// writing at all.
import type { FileOps } from "../types";
import { compileSummary, type CompiledSummary } from "../core/summarize";
import { readState } from "../core/summary-state";
import { mergeHistoryIndex, rangeOfWindow, readHistoryIndex, unindexedRange, type HistoryRange } from "../core/history-index";
import { readPins } from "../core/pins";
import { lastCompactionIndex, lastResetIndex } from "../core/session-file";
import { restoreOriginals } from "../core/raw-store";
import { buildWorkingSet } from "../core/working-set";
import { estimateMessageChars } from "../core/token-estimate";
import type { CompactionBudgets } from "../core/window";
import type { VccSettings } from "../core/settings";
import { vccDetailsOf } from "../details";
import { summaryInputOf, toLiveMessage } from "./summary-input";
import type { ConvertToLlm } from "../host";
import type { OwnCutResult } from "./cut";

/** Growth a summary may add before it is not worth writing: its framing (the
 * budgets' growthMarginChars), or this share of what it replaces. */
const GROWTH_MARGIN_SHARE = 0.25;

interface SummaryGrowth {
  /** What the new summary adds beyond the previous one it replaces, less the messages it summarizes. */
  netChars: number;
  allowedChars: number;
  grows: boolean;
}

/**
 * Whether writing this summary would make the context bigger. The new summary
 * replaces the previous one and the summarized messages; the kept tail is the
 * same either way. A short prefix (two messages after omp's plan-mode "approve
 * and compact", a session barely past a low threshold) can be smaller than the
 * sections and brief that would replace it.
 */
export const summaryGrowth = (
  summaryChars: number,
  previousSummaryChars: number,
  prefixChars: number,
  marginChars: number,
): SummaryGrowth => {
  const netChars = summaryChars - previousSummaryChars - prefixChars;
  const allowedChars = Math.max(marginChars, Math.round(prefixChars * GROWTH_MARGIN_SHARE));
  return { netChars, allowedChars, grows: netChars > allowedChars };
};

interface AssembleInput {
  /** The branch as the context holds it. */
  branchEntries: any[];
  cut: Extract<OwnCutResult, { ok: true }>;
  convert: ConvertToLlm;
  /** The session file, whose kept originals put back what omp rewrote in place. */
  sessionFile: string | undefined;
  /** `#N` by entry id. */
  indexById: Map<string, number> | undefined;
  /** The host's previous summary, when it has one in context. */
  previousSummary: string | undefined;
  /** The host's file activity for its cut. */
  fileOps: FileOps;
  settings: Pick<VccSettings, "skipCustomTypes" | "trackCommands">;
  budgets: CompactionBudgets;
  charsPerToken: number;
}

interface Assembled {
  compiled: CompiledSummary;
  /** Messages the summary covers (the cut's, less skipped custom types). */
  summarized: number;
  historyIndex?: HistoryRange[];
  /** The #N of what [Working Set] brought back. */
  workingSet?: number[];
  growth: SummaryGrowth;
}

export const assembleSummary = (input: AssembleInput): Assembled => {
  const { branchEntries, cut, budgets, settings } = input;
  // omp may have blanked or shaken some of these in place since they landed.
  // The summary is all that will remain of them, so it is written from the
  // originals omp-vcc kept (core/raw-store.ts); the cut and the budgets count
  // what the context holds now.
  const restored = restoreOriginals(cut.messages, cut.selectedIds, input.sessionFile);
  const summaryInput = summaryInputOf(restored, cut.selectedIds, settings.skipCustomTypes, input.convert);
  // Fail-closed: without an index map every ref is left out, never window-relative.
  const sourceIndices = summaryInput.ids.map((id) => input.indexById?.get(id));
  const removedChars = cut.messages.reduce((sum: number, m: any) => sum + estimateMessageChars(m), 0);

  // The previous compaction still in context: after omp's /clear (a later
  // reset_boundary) the summary and [History Index] start over.
  const lastCompactionIdx = lastCompactionIndex(branchEntries);
  const previousCompaction = lastCompactionIdx >= 0 ? branchEntries[lastCompactionIdx] : undefined;
  const previousDetails = previousCompaction ? vccDetailsOf(previousCompaction.details) : undefined;

  // [History Index]: this window's range added to the one the previous compaction stored.
  const windowRange = rangeOfWindow(summaryInput.messages, sourceIndices);
  const storedIndex = previousCompaction ? readHistoryIndex(previousDetails?.historyIndex) : [];
  const historyIndex = windowRange
    ? mergeHistoryIndex(
        storedIndex ?? (windowRange.from > 0 ? [unindexedRange(windowRange.from - 1)] : []),
        windowRange,
        budgets.summary.historyRanges,
      )
    : undefined;

  // [Working Set]: what the next step likely needs, brought back from the
  // originals with the compaction (core/working-set.ts), so the agent does not
  // spend its next requests fetching it again.
  let workingSet: { lines: string[]; shown: number[] } | undefined;
  // The budgets give it no room when the setting is off.
  if (budgets.workingSetTokens > 0) {
    const keptAt = cut.firstKeptEntryId ? branchEntries.findIndex((e: any) => e.id === cut.firstKeptEntryId) : -1;
    const kept = keptAt >= 0 ? branchEntries.slice(keptAt).map(toLiveMessage).filter(Boolean) : [];
    // Everything out of context once this lands, since /clear: what this
    // compaction summarizes and what earlier ones did, from the originals.
    const past = branchEntries
      .slice(lastResetIndex(branchEntries) + 1, keptAt >= 0 ? keptAt : branchEntries.length)
      .map((e: any) => ({ id: e.id as string, m: toLiveMessage(e) }))
      .filter((x) => x.m);
    const pastIds = past.map((x) => x.id);
    const built = buildWorkingSet({
      history: restoreOriginals(past.map((x) => x.m), pastIds, input.sessionFile),
      indices: pastIds.map((id) => input.indexById?.get(id)),
      kept,
      budgetChars: budgets.workingSetTokens * input.charsPerToken,
      removedChars,
    });
    if (built.lines.length > 0) workingSet = built;
  }

  // The previous summary's sections: the state its compaction stored, or its
  // text when an older version or another compactor wrote it.
  const storedState = input.previousSummary !== undefined && previousCompaction ? readState(previousDetails?.summaryState) : undefined;
  const compiled = compileSummary({
    previous: storedState,
    previousSummary: input.previousSummary,
    previousSummaryForeign: !!previousCompaction && !previousDetails,
    messages: summaryInput.messages,
    sourceIndices,
    historyIndex,
    pinnedNotes: readPins(branchEntries),
    workingSet: workingSet?.lines,
    fileOps: input.fileOps,
    trackCommands: settings.trackCommands,
    limits: budgets.summary,
    ranking: {
      maxBriefChars: Math.round(budgets.briefTokens * input.charsPerToken),
      maxBriefCharsCeiling: Math.round(budgets.briefCeilingTokens * input.charsPerToken),
      briefCharsPerBlock: Math.round(budgets.briefTokensPerBlock * input.charsPerToken),
      maxBlocks: budgets.briefMaxBlocks,
    },
  });

  return {
    compiled,
    summarized: summaryInput.summarized,
    ...(historyIndex ? { historyIndex } : {}),
    ...(workingSet ? { workingSet: workingSet.shown } : {}),
    growth: summaryGrowth(compiled.text.length, input.previousSummary?.length ?? 0, removedChars, budgets.growthMarginChars),
  };
};
