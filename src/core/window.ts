// Limits that follow the model's context window instead of fixed numbers.
//
// omp knows a model's window from its provider (with discovery configured),
// its catalog, models.yml or a 128K default, and compacts at a trigger
// below it (window less a reserve, or the user's threshold). After a compaction
// the context must land inside omp's recovery band (80% of the trigger) or omp
// treats it as a dead end and starts shaking tool output; a 25k-token kept tail
// does that on a small window, and a 2k-token summary is needlessly thin on a
// 1M one. So the tail, the smart-keep trigger, the summary budget, the size of
// each summary section and the growth a summary may add are shares of the
// trigger, clamped like the recall cap (recallOutputChars): the same numbers as
// before on a typical 128K window, smaller below it, a larger summary far above it.
//
// The window itself is the smaller of the host's and a limit an overflow error
// stated; omp-vcc makes no network call. The trigger is the host's own: its
// compaction policy (omp: threshold, reserve, the model's entry; Pi: its
// reserve) arrives with every compaction, and the host's TriggerRule applies it
// to that window as the host does (ompTrigger, piTrigger). Pi re-compacts only
// past its trigger, so the landing below omp's recovery band suits it too. Pure
// functions; the IO is in model-limits.ts.

/** Clamp `value` to [floor, ceiling], rounded. */
const clampTokens = (value: number, floor: number, ceiling: number): number =>
  Math.round(Math.max(floor, Math.min(ceiling, value)));

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
 * omp's compaction policy for the current model, as omp hands it to extensions
 * in `session_before_compact` (`preparation.settings`, pi-agent-core's
 * CompactionSettings, with the model's `compaction.modelThresholds` entry
 * already applied). Only the fields that decide where omp compacts.
 */
export interface OmpCompactionPolicy {
  enabled?: boolean;
  strategy?: string;
  /** Compact at this share of the window (1–99). */
  thresholdPercent?: number;
  /** Compact at this many tokens; wins over the percentage. */
  thresholdTokens?: number;
  /** A model entry's token count, standing in for the window under the percentage or the reserve. */
  baseWindowTokens?: number;
  /** Kept free below the window; unset means omp's default, which a small window may override. */
  reserveTokens?: number;
}

/** omp's reserve when `reserveTokens` is unset (pi-agent-core DEFAULT_RESERVE_TOKENS). */
const OMP_DEFAULT_RESERVE_TOKENS = 16_384;

const finitePositive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** The policy fields in omp's `preparation.settings`, or undefined when there are none. */
export const ompPolicyOf = (settings: unknown): OmpCompactionPolicy | undefined => {
  if (!isRecord(settings)) return undefined;
  const policy: OmpCompactionPolicy = {};
  if (typeof settings.enabled === "boolean") policy.enabled = settings.enabled;
  if (typeof settings.strategy === "string") policy.strategy = settings.strategy;
  for (const key of ["thresholdPercent", "thresholdTokens", "baseWindowTokens", "reserveTokens"] as const) {
    const n = settings[key];
    if (typeof n === "number" && Number.isFinite(n)) policy[key] = n;
  }
  return policy;
};

/** Whether omp compacts on its own under this policy. */
export const ompAutoCompacts = (policy: OmpCompactionPolicy | undefined): boolean =>
  policy?.enabled !== false && policy?.strategy !== "off";

/** The reserve below the window omp keeps (pi-agent-core resolveBudgetReserveTokens). */
const ompReserve = (window: number, policy: OmpCompactionPolicy): number => {
  const proportional = Math.max(1, Math.floor(window * 0.15));
  const reserve = Math.max(Math.floor(window * 0.15), policy.reserveTokens ?? OMP_DEFAULT_RESERVE_TOKENS);
  const defaulted = policy.reserveTokens === undefined;
  return (defaulted && reserve >= window - proportional) || reserve >= window ? proportional : reserve;
};

const ompPromptBudget = (window: number, policy: OmpCompactionPolicy): number =>
  Math.max(0, Math.min(window - 1, window - ompReserve(window, policy)));

/**
 * Where omp compacts on `window` under `policy`: pi-agent-core's
 * resolveThresholdTokens, which omp does not export to extensions. A fixed
 * token threshold is exact unless it is at or past the window (then the window
 * less its reserve); otherwise a percentage of the window (or of a model
 * entry's base), or by default the window less a reserve of 15% or 16,384
 * tokens, whichever is larger (15% alone when that would not fit).
 */
export const ompTrigger = (window: number, policy: OmpCompactionPolicy = {}): number => {
  const fixed = finitePositive(policy.thresholdTokens);
  if (fixed) return fixed >= window ? ompPromptBudget(window, policy) : Math.min(window - 1, Math.max(1, fixed));
  const base = finitePositive(policy.baseWindowTokens);
  const scaled = base ? Math.min(window, base) : window;
  const percent = finitePositive(policy.thresholdPercent);
  if (!percent) return ompPromptBudget(scaled, policy);
  return Math.floor(scaled * (Math.min(99, Math.max(1, percent)) / 100));
};

/** Where omp compacts on `window` with its default policy. */
export const ompDefaultTrigger = (window: number): number => Math.max(1, ompTrigger(window));

/**
 * Pi's compaction settings for the current model, as Pi hands them to
 * extensions in `session_before_compact` (`preparation.settings`, its
 * CompactionSettings from settingsManager.getCompactionSettings(model)). Only
 * the fields that decide where Pi compacts.
 */
export interface PiCompactionPolicy {
  enabled?: boolean;
  /** Kept free below the window; Pi's DEFAULT_COMPACTION_SETTINGS has 16,384. */
  reserveTokens?: number;
}

/** Pi's reserve when `reserveTokens` is unset (DEFAULT_COMPACTION_SETTINGS). */
const PI_DEFAULT_RESERVE_TOKENS = 16_384;

/** The policy fields in Pi's `preparation.settings`, or undefined when there are none. */
export const piPolicyOf = (settings: unknown): PiCompactionPolicy | undefined => {
  if (!isRecord(settings)) return undefined;
  const policy: PiCompactionPolicy = {};
  if (typeof settings.enabled === "boolean") policy.enabled = settings.enabled;
  if (typeof settings.reserveTokens === "number" && Number.isFinite(settings.reserveTokens)) policy.reserveTokens = settings.reserveTokens;
  return policy;
};

/**
 * Where Pi compacts on `window`: its shouldCompact, `contextTokens >
 * contextWindow - reserveTokens` (core/compaction/compaction.ts), which Pi
 * applies with `enabled` on. A reserve at or past the window would compact on
 * every turn; the trigger is then 1.
 */
export const piTrigger = (window: number, policy: PiCompactionPolicy = {}): number => {
  const reserve = typeof policy.reserveTokens === "number" && Number.isFinite(policy.reserveTokens)
    ? Math.max(0, policy.reserveTokens)
    : PI_DEFAULT_RESERVE_TOKENS;
  return Math.max(1, Math.floor(window - reserve));
};

/** Whether Pi compacts on its own under this policy. */
export const piAutoCompacts = (policy: PiCompactionPolicy | undefined): boolean => policy?.enabled !== false;

/**
 * A host's compaction rule, from its own code: the policy it hands the hook
 * (`preparation.settings`), where it compacts under that policy, and whether it
 * compacts on its own at all. omp-vcc sizes each compaction for where the host
 * compacts next, so the rule is the host's, never a guess.
 */
export interface TriggerRule {
  host: "omp" | "pi";
  policyOf(settings: unknown): object | undefined;
  trigger(window: number, policy?: object): number;
  autoCompacts(policy: object | undefined): boolean;
}

export const OMP_TRIGGER_RULE: TriggerRule = {
  host: "omp",
  policyOf: ompPolicyOf,
  trigger: (window, policy) => ompTrigger(window, policy as OmpCompactionPolicy | undefined),
  autoCompacts: (policy) => ompAutoCompacts(policy as OmpCompactionPolicy | undefined),
};

export const PI_TRIGGER_RULE: TriggerRule = {
  host: "pi",
  policyOf: piPolicyOf,
  trigger: (window, policy) => piTrigger(window, policy as PiCompactionPolicy | undefined),
  autoCompacts: (policy) => piAutoCompacts(policy as PiCompactionPolicy | undefined),
};

/** omp re-compacts unless the result lands at or under this share of the trigger. */
export const RECOVERY_BAND = 0.8;
/** omp-vcc aims lower, so the turn after a compaction has room before the next one. */
const LANDING_SHARE = 0.6;
/** The kept tail is at most this share of the trigger. */
const TAIL_SHARE = 0.25;
/** A rough allowance for the summary's sections around the brief, at full size. */
const SECTIONS_TOKENS = 600;
/** omp's trigger on a 128K window: where the fixed numbers were tuned. */
const REFERENCE_TRIGGER = ompDefaultTrigger(128_000);

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
}

/** The section sizes from before the window was known; still those of a ~128K window. */
export const DEFAULT_SUMMARY_LIMITS: SummaryLimits = {
  userMessages: 15,
  filesPerCategory: 10,
  commits: 8,
  historyRanges: 8,
  briefLines: 120,
};

/** Never fewer than these, however small the window. */
const SUMMARY_LIMIT_FLOORS: SummaryLimits = {
  userMessages: 4,
  filesPerCategory: 3,
  commits: 2,
  historyRanges: 3,
  briefLines: 30,
};

export interface CompactionBudgets {
  /** Largest kept tail (smart keep-tail growth, token-budget cuts). */
  maxTailTokens: number;
  /** Smart keep-tail grows keep:1 only when its tail is at most this. */
  minTailTokens: number;
  /** The ranked brief's floor and ceiling. */
  briefTokens: number;
  briefCeilingTokens: number;
  /**
   * Chars a summary may add beyond what it replaces before it is not written
   * (or a share of the prefix, when larger): its framing, which grows with its sections.
   */
  growthMarginChars: number;
  /** Section sizes; summaryScale of the defaults. */
  summary: SummaryLimits;
  summaryScale: number;
  /** What [Working Set] may bring back (core/working-set.ts); 0 on a window too small for it. */
  workingSetTokens: number;
}

/** The fixed values from before the window was known; still the budgets for a ~128K window. */
export const DEFAULT_BUDGETS: CompactionBudgets = {
  maxTailTokens: 25_000,
  minTailTokens: 5_000,
  briefTokens: 1_100,
  briefCeilingTokens: 2_000,
  growthMarginChars: 500,
  summary: { ...DEFAULT_SUMMARY_LIMITS },
  summaryScale: 1,
  workingSetTokens: 3_800,
};

/**
 * [Working Set] takes at most this share of the trigger, and nothing when that is
 * under the floor. A smaller window needs it most: in real runs on a 40K window,
 * a 3.5% share (about 3k chars) held no whole source file, and the agent read
 * the files again; 14% holds them. On a ~128K window the cap above binds first.
 */
const WORKING_SET_SHARE = 0.14;
const MIN_WORKING_SET_TOKENS = 400;
/** The kept tail's floor: the working set takes only the landing room above it. */
const MIN_TAIL_TOKENS = 1_000;

/**
 * How much of each section list a summary keeps, against a ~128K window. Below
 * it, the square root of the trigger's share (a 32K window keeps about 40%),
 * never under a quarter: a small window needs the room, but the lists are
 * where a long task keeps its bearings. Above it, nothing changes until the
 * brief's ceiling grows (a trigger past 500K), then the lists grow with it.
 */
export const summaryScale = (trigger: number, briefCeilingTokens: number): number =>
  trigger < REFERENCE_TRIGGER
    ? Math.max(0.25, Math.sqrt(trigger / REFERENCE_TRIGGER))
    : Math.max(1, briefCeilingTokens / DEFAULT_BUDGETS.briefCeilingTokens);

/** The default section sizes scaled by `scale`, each at or above its floor. */
export const summaryLimits = (scale: number): SummaryLimits => {
  const limits = { ...DEFAULT_SUMMARY_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof SummaryLimits>) {
    limits[key] = Math.max(SUMMARY_LIMIT_FLOORS[key], Math.round(DEFAULT_SUMMARY_LIMITS[key] * scale));
  }
  return limits;
};

/**
 * Budgets for a compaction that runs at `trigger` tokens, with `overheadTokens`
 * of context the compaction cannot remove (system prompt, tool schemas):
 * what is kept plus the summary lands at or under LANDING_SHARE of the trigger.
 * Unknown trigger: the defaults. Without a working set (the `workingSet`
 * setting off), its room goes to the kept tail.
 */
export const compactionBudgets = (trigger?: number, overheadTokens = 0, withWorkingSet = true): CompactionBudgets => {
  const t = positive(trigger);
  if (!t) return { ...DEFAULT_BUDGETS, summary: { ...DEFAULT_SUMMARY_LIMITS }, workingSetTokens: withWorkingSet ? DEFAULT_BUDGETS.workingSetTokens : 0 };
  const briefCeilingTokens = Math.round(Math.min(0.1 * t, clampTokens(0.004 * t, DEFAULT_BUDGETS.briefCeilingTokens, 6_000)));
  const briefTokens = Math.round(Math.min(DEFAULT_BUDGETS.briefTokens, 0.06 * t, briefCeilingTokens));
  const scale = summaryScale(t, briefCeilingTokens);
  // What a compaction may land with besides the summary: the kept tail and the working set.
  const landing = LANDING_SHARE * t - Math.max(0, overheadTokens) - briefCeilingTokens - SECTIONS_TOKENS * scale;
  // The same on a ~128K window up to where the brief grows, then with it; a share of a smaller
  // trigger, out of the landing room above the tail's floor, so it never pushes a compaction
  // past where omp expects it to land.
  const wanted = Math.round(Math.min(DEFAULT_BUDGETS.workingSetTokens * Math.max(1, scale), WORKING_SET_SHARE * t, landing - MIN_TAIL_TOKENS));
  const workingSetTokens = withWorkingSet && wanted >= MIN_WORKING_SET_TOKENS ? wanted : 0;
  const maxTailTokens = clampTokens(Math.min(TAIL_SHARE * t, landing - workingSetTokens), MIN_TAIL_TOKENS, DEFAULT_BUDGETS.maxTailTokens);
  return {
    maxTailTokens,
    minTailTokens: Math.round(maxTailTokens / 5),
    briefTokens,
    briefCeilingTokens,
    growthMarginChars: Math.round(DEFAULT_BUDGETS.growthMarginChars * Math.max(1, scale)),
    summary: summaryLimits(scale),
    summaryScale: Math.round(scale * 100) / 100,
    workingSetTokens,
  };
};
