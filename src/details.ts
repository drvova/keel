import type { CompactionReason } from "./types";
import type { HistoryRange, SummaryState } from "./core/summarize";
import { COMPACTOR, LEGACY_COMPACTOR } from "./names";
import type { HostName } from "./host";
import { core } from "./core/lisp-core";

/** Compactions stored before the rename say "pi-vcc"; both are read as this extension's. */
type VccCompactor = typeof COMPACTOR | typeof LEGACY_COMPACTOR;

export interface VccCompactionDetails {
  compactor: VccCompactor;
  version: number;
  /** The sections the summary shows, in order. */
  sections: string[];
  /** What the summary shows of its carried sections, which the next compaction merges into (core/summarize.ts). */
  summaryState?: SummaryState;
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  reason?: CompactionReason;
  willRetry?: boolean;
  /** The [History Index] ranges, carried to the next compaction . */
  historyIndex?: HistoryRange[];
  /** The #N of the entries [Working Set] brought back . */
  workingSet?: number[];
  /** The window and trigger the budgets were sized from (core/window.ts). */
  limits?: {
    contextWindow?: number;
    windowSource?: HostName | "overflow-error" | "unknown";
    trigger?: number;
    /** System prompt and tools, which a compaction cannot remove. */
    overheadTokens?: number;
    maxTailTokens: number;
    briefCeilingTokens: number;
    /** Section sizes against a ~128K window's, when they differ (core/window.ts summaryScale). */
    summaryScale?: number;
    /** What [Working Set] could bring back. */
    workingSetTokens?: number;
  };
}

/**
 * This extension's details on a compaction entry, or undefined for another
 * compactor's. omp's notes-backed rollover nests a hook's details under hookDetails.
 */
export const vccDetailsOf = (details: unknown): (Partial<VccCompactionDetails> & { compactor: VccCompactor }) | undefined =>
  (core({ op: "outcome", details: details ?? null }).own as (Partial<VccCompactionDetails> & { compactor: VccCompactor }) | undefined) ?? undefined;
