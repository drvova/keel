// A compaction's summary: this window's sections, merged into the previous
// summary's (core/summary-state.ts), rendered once (core/format.ts).
import type { Message } from "@oh-my-pi/pi-ai";
import type { FileOps } from "../types";
import { summaryBlocks } from "./normalize";
import { EARLY_REQUESTS_KEPT } from "../extract/user-messages";
import { renderSummary } from "./format";
import { legacyPrevious, withFullPaths } from "./legacy-summary";
import { capState, freshState, mergeStates, type PreviousSummary, type SummaryState } from "./summary-state";
import { selectRankedBriefBlocks, type BriefRankingOptions } from "./rank";
import { formatHistoryRange, type HistoryRange } from "./history-index";
import { formatPinLines, type PinnedNote } from "./pins";
import type { SummaryLimits } from "./window";

export interface CompileInput {
  messages: Message[];
  /** The state the previous compaction stored; when absent, `previousSummary` is read from its text. */
  previous?: PreviousSummary;
  /** The previous summary's text: one an older version or another compactor wrote. */
  previousSummary?: string;
  /** Another compactor (an LLM) wrote `previousSummary`, not omp-vcc or pi-vcc. */
  previousSummaryForeign?: boolean;
  fileOps?: FileOps;
  /**
   * Session-global `#N` index per message position (see
   * src/core/session-file.ts). Parallel to `messages`; a missing entry
   * renders as no ref (fail-closed). Omitted entirely → legacy positional.
   */
  sourceIndices?: Array<number | undefined>;
  /** Command names for [Tracked Commands] (VccSettings.trackCommands); none by default. */
  trackCommands?: readonly string[];
  /** The history index to show, already merged with the previous one (core/history-index.ts). */
  historyIndex?: readonly HistoryRange[];
  /** The pinned notes (core/pins.ts). */
  pinnedNotes?: readonly PinnedNote[];
  /** [Working Set] lines (core/working-set.ts). */
  workingSet?: readonly string[];
  /** How many items each section keeps (core/window.ts: they follow the model's window). */
  limits: SummaryLimits;
  /** How the brief is ranked; its file activity is `fileOps`. */
  ranking?: Omit<BriefRankingOptions, "fileOps">;
}

export interface CompiledSummary {
  text: string;
  /** What the summary shows of its carried sections, stored for the next compaction to merge into. */
  state: SummaryState;
  /** The sections it shows, in order. */
  sections: string[];
}

/** The summary, and what to store for the next compaction. */
export const compileSummary = (input: CompileInput): CompiledSummary => {
  const blocks = summaryBlocks(input.messages, input.sourceIndices);
  // A summary read from its text: every rule for one is here (legacy-summary.ts).
  const legacy = !input.previous && input.previousSummary ? legacyPrevious(input.previousSummary, input.previousSummaryForeign) : undefined;
  const previous = input.previous ?? legacy;
  const fresh = freshState({
    blocks,
    briefBlocks: selectRankedBriefBlocks(blocks, { ...input.ranking, fileOps: input.fileOps }),
    fileOps: input.fileOps,
    trackCommands: input.trackCommands,
    earlySlots: previous?.earlySlots ?? EARLY_REQUESTS_KEPT,
  });
  const merged = mergeStates(legacy ? withFullPaths(legacy, fresh) : previous, fresh, input.limits);
  const { text, sections } = renderSummary({
    state: merged,
    limits: input.limits,
    pins: input.pinnedNotes && input.pinnedNotes.length > 0 ? formatPinLines(input.pinnedNotes) : undefined,
    history: input.historyIndex?.map(formatHistoryRange),
    workingSet: input.workingSet,
  });
  return { text, state: capState(merged, input.limits), sections };
};

/** The summary's text alone, for scripts and tests that read only it. */
export const compile = (input: CompileInput): string => compileSummary(input).text;
