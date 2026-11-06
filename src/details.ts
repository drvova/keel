import type { CompactionReason } from "./types";
import type { HistoryRange } from "./core/history-index";
import type { SummaryState } from "./core/summary-state";
import { COMPACTOR, LEGACY_COMPACTOR } from "./names";
import type { HostName } from "./host";

/** Compactions stored before the rename say "pi-vcc"; both are read as this extension's. */
export type VccCompactor = typeof COMPACTOR | typeof LEGACY_COMPACTOR;

export const isVccCompactor = (value: unknown): value is VccCompactor => value === COMPACTOR || value === LEGACY_COMPACTOR;

export interface VccCompactionDetails {
  compactor: VccCompactor;
  version: number;
  /** The sections the summary shows, in order. */
  sections: string[];
  /** What the summary shows of its carried sections, which the next compaction merges into (core/summary-state.ts). */
  summaryState?: SummaryState;
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  reason?: CompactionReason;
  willRetry?: boolean;
  /** The [History Index] ranges, carried to the next compaction (core/history-index.ts). */
  historyIndex?: HistoryRange[];
  /** The #N of the entries [Working Set] brought back (core/working-set.ts). */
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
export const vccDetailsOf = (details: unknown): (Partial<VccCompactionDetails> & { compactor: VccCompactor }) | undefined => {
  const d = details as { compactor?: unknown; hookDetails?: unknown } | undefined;
  const own = isVccCompactor(d?.compactor) ? d : (d?.hookDetails as typeof d | undefined);
  return isVccCompactor(own?.compactor) ? (own as Partial<VccCompactionDetails> & { compactor: VccCompactor }) : undefined;
};
