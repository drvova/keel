// Limits that follow the model's context window instead of fixed numbers.
//
// omp knows a model's window from its provider's /models (when the provider
// says), its catalog, models.yml or a 128K default, and compacts at a trigger
// below it (window less a reserve, or the user's threshold). After a compaction
// the context must land inside omp's recovery band (80% of the trigger) or omp
// treats it as a dead end and starts shaking tool output; a 25k-token kept tail
// does that on a small window, and a 2k-token summary is needlessly thin on a
// 1M one. So the tail, the smart-keep trigger and the summary budget are shares
// of the trigger, clamped like the recall cap (recallOutputChars): the same
// numbers as before on a typical 128K window, smaller below it, a larger summary
// ceiling far above it.
//
// The window itself is the smallest one known: omp's, the provider's /models
// answer, and a limit an overflow error stated. Pure functions; the IO is in
// model-limits.ts.

/** Clamp `value` to [floor, ceiling], rounded. */
const clampTokens = (value: number, floor: number, ceiling: number): number =>
  Math.round(Math.max(floor, Math.min(ceiling, value)));

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The context length in one entry of an OpenAI-compatible `/models` list, as
 * providers spell it: `context_length` (OpenRouter, Electron Hub, Together),
 * `max_model_len` (vLLM), `max_input_tokens`, `context_window` (Groq), or nested
 * under `limits`, `top_provider` or `metadata`. Undefined when it says nothing.
 */
export const contextLengthOfModelEntry = (entry: unknown): number | undefined => {
  if (!isRecord(entry)) return undefined;
  const nested = (key: string) => (isRecord(entry[key]) ? (entry[key] as Record<string, unknown>) : undefined);
  const candidates = [
    entry.context_length, entry.max_model_len, entry.max_input_tokens, entry.context_window, entry.max_context_length,
    nested("limits")?.max_input_tokens, nested("limits")?.context, nested("limits")?.context_window,
    nested("top_provider")?.context_length,
    nested("metadata")?.context_window, nested("metadata")?.context_length,
  ];
  for (const c of candidates) {
    const n = positive(typeof c === "string" && /^\d+$/.test(c) ? Number(c) : c);
    if (n) return n;
  }
  return undefined;
};

// Overflow errors that state the limit. Each captures the limit, not the request size.
const LIMIT_PATTERNS: RegExp[] = [
  /maximum context length is (\d[\d,]*) tokens/i, // OpenAI-compatible, OpenRouter, vLLM
  /context length of only (\d[\d,]*) tokens/i,
  /prompt is too long: \d[\d,]* tokens > (\d[\d,]*) maximum/i, // Anthropic
  /maximum prompt length is (\d[\d,]*)/i, // xAI
  /exceeds the maximum number of tokens allowed \((\d[\d,]*)\)/i, // Gemini
  /exceeds the context window of (\d[\d,]*)/i,
  /exceeds the (?:context|token) limit of (\d[\d,]*)/i,
  /exceeds the limit of (\d[\d,]*) tokens/i,
  /exceeds the context \((\d[\d,]*)\)/i, // Strata
  /in the context \((\d[\d,]*)\)/i, // Strata "leaves no room"
  /available context size \((\d[\d,]*) tokens\)/i, // llama.cpp
  /\bn_ctx[^\d]{0,12}(\d[\d,]*)/i, // llama.cpp n_ctx variants
  /context (?:window|length|size) (?:is|of) (\d[\d,]*)/i,
  /greater than the context length of (\d[\d,]*)/i, // LM Studio
];

/** The context limit an overflow error states, or undefined when it names none. */
export const limitFromOverflowError = (text: unknown): number | undefined => {
  if (typeof text !== "string" || !text) return undefined;
  for (const re of LIMIT_PATTERNS) {
    const m = text.match(re);
    const n = m ? positive(Number(m[1].replace(/,/g, ""))) : undefined;
    // A limit under 1k tokens is a media or message cap, not a context window.
    if (n && n >= 1024) return n;
  }
  return undefined;
};

/** The smallest window known; undefined when none is. */
export const effectiveWindow = (...windows: Array<number | undefined>): number | undefined => {
  const known = windows.map(positive).filter((n): n is number => n !== undefined);
  return known.length > 0 ? Math.min(...known) : undefined;
};

/**
 * Where omp compacts on `window` with its default policy: the window less a
 * reserve of 15% of it or 16,384 tokens, whichever is larger, and 15% alone when
 * that reserve would not fit (compaction.ts resolveBudgetReserveTokens). A user's
 * threshold moves this; a threshold pass measures the real one (tokensBefore).
 */
export const ompDefaultTrigger = (window: number): number => {
  const proportional = Math.max(1, Math.floor(window * 0.15));
  let reserve = Math.max(proportional, 16_384);
  if (reserve >= window - proportional) reserve = proportional;
  return Math.max(1, Math.min(window - 1, window - reserve));
};

/** omp re-compacts unless the result lands at or under this share of the trigger. */
export const RECOVERY_BAND = 0.8;
/** omp-vcc aims lower, so the turn after a compaction has room before the next one. */
const LANDING_SHARE = 0.6;
/** The kept tail is at most this share of the trigger. */
const TAIL_SHARE = 0.25;
/** A rough allowance for the summary's sections around the brief. */
const SECTIONS_TOKENS = 600;

export interface CompactionBudgets {
  /** Largest kept tail (smart keep-tail growth, token-budget cuts). */
  maxTailTokens: number;
  /** Smart keep-tail grows keep:1 only when its tail is at most this. */
  minTailTokens: number;
  /** The ranked brief's floor and ceiling. */
  briefTokens: number;
  briefCeilingTokens: number;
}

/** The fixed values from before the window was known; still the budgets for a ~128K window. */
export const DEFAULT_BUDGETS: CompactionBudgets = {
  maxTailTokens: 25_000,
  minTailTokens: 5_000,
  briefTokens: 1_100,
  briefCeilingTokens: 2_000,
};

/**
 * Budgets for a compaction that runs at `trigger` tokens, with `overheadTokens`
 * of context the compaction cannot remove (system prompt, tool schemas):
 * what is kept plus the summary lands at or under LANDING_SHARE of the trigger.
 * Unknown trigger: the defaults.
 */
export const compactionBudgets = (trigger?: number, overheadTokens = 0): CompactionBudgets => {
  const t = positive(trigger);
  if (!t) return { ...DEFAULT_BUDGETS };
  const briefCeilingTokens = Math.round(Math.min(0.1 * t, clampTokens(0.004 * t, DEFAULT_BUDGETS.briefCeilingTokens, 6_000)));
  const briefTokens = Math.round(Math.min(DEFAULT_BUDGETS.briefTokens, 0.06 * t, briefCeilingTokens));
  const room = LANDING_SHARE * t - Math.max(0, overheadTokens) - briefCeilingTokens - SECTIONS_TOKENS;
  const maxTailTokens = clampTokens(Math.min(TAIL_SHARE * t, room), 1_000, DEFAULT_BUDGETS.maxTailTokens);
  return {
    maxTailTokens,
    minTailTokens: Math.round(maxTailTokens / 5),
    briefTokens,
    briefCeilingTokens,
  };
};
