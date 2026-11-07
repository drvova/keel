// The shapes the core's window rules hand back (lisp/src/window.lisp): where the
// host compacts next under the policy it hands the hook, and the budgets that
// land below it. The core works them out; these are what the TS side reads.

/** Whose compaction rule a host follows: the core applies omp's or Pi's by this name. */
export type TriggerRule = "omp" | "pi";

/** How many items each summary section keeps. */
export interface SummaryLimits {
  /** [User Messages] lines. */
  userMessages: number;
  /** Paths per [Files And Changes] category. */
  filesPerCategory: number;
  /** [Commits] lines. */
  commits: number;
  /** [History Index] lines. */
  historyRanges: number;
  /** Brief transcript lines, a merged one included. */
  briefLines: number;
  /** [Tracked Commands] invocations kept per command name. */
  commandsPerName: number;
}

/** The budgets of a compaction, from its trigger (lisp/src/window.lisp compaction-budgets). */
export interface CompactionBudgets {
  /** Largest kept tail (smart keep-tail growth, token-budget cuts). */
  maxTailTokens: number;
  /** Smart keep-tail grows keep:1 only when its tail is at most this. */
  minTailTokens: number;
  /** The ranked brief's floor and ceiling, and what each block it covers adds between them. */
  briefTokens: number;
  briefCeilingTokens: number;
  briefTokensPerBlock: number;
  /** Blocks the ranked brief takes at most, whatever their size. */
  briefMaxBlocks: number;
  /**
   * Chars a summary may add beyond what it replaces before it is not written
   * (or a share of the prefix, when larger): its framing, which grows with its sections.
   */
  growthMarginChars: number;
  /** Section sizes; summaryScale of the defaults. */
  summary: SummaryLimits;
  summaryScale: number;
  /** What [Working Set] may bring back (lisp/src/working-set.lisp); 0 on a window too small for it. */
  workingSetTokens: number;
}
