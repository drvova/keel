import type { CompactionReason } from "./types";
import type { HistoryRange } from "./core/history-index";

export interface PiVccCompactionDetails {
  compactor: "pi-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  reason?: CompactionReason;
  willRetry?: boolean;
  /** The [History Index] ranges, carried to the next compaction (core/history-index.ts). */
  historyIndex?: HistoryRange[];
}
