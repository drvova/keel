// The window rules as the core applies them (lisp/src/window.lisp, op window):
// an overflow error's limit, each host's trigger under the policy it hands the
// hook, and the budgets below a trigger, with the defaults those make.
import { core } from "../../src/core/lisp-core";
import type { CompactionBudgets, SummaryLimits, TriggerRule } from "./window-shapes";

const one = (c: Record<string, unknown>): any => (core({ op: "window", cases: [c] }).results as any[])[0];

/** The context limit an overflow error states, or undefined when it names none. */
export const limitFromOverflowError = (error: unknown): number | undefined => one({ error: error ?? null }).limit ?? undefined;

/** Where the host compacts on WINDOW with the compaction settings it hands the hook (none: its defaults). */
export const hostTrigger = (window: number, hostSettings?: unknown, rule: TriggerRule = "omp"): number =>
  one({ ruleName: rule, window, ...(hostSettings !== undefined ? { hostSettings } : {}) }).trigger;

/** The policy the core reads from those settings. */
export const policyOf = (hostSettings: unknown, rule: TriggerRule = "omp"): Record<string, unknown> | undefined =>
  one({ ruleName: rule, hostSettings }).policy ?? undefined;

/** Whether the host compacts on its own under those settings. */
export const autoCompacts = (hostSettings: unknown, rule: TriggerRule = "omp"): boolean => one({ ruleName: rule, hostSettings }).autoCompacts;

/** Where omp compacts on WINDOW with its default policy. */
export const ompDefaultTrigger = (window: number): number => hostTrigger(window);

/**
 * The trigger a compaction sizes for: the host's on WINDOW under POLICY, a
 * recovery bounded by the context it counted.
 */
export const triggerFor = (window: number | undefined, recovering: boolean, tokensBefore: number, policy?: object, rule: TriggerRule = "omp"): number | undefined =>
  one({ ruleName: rule, window: window ?? null, recovering, tokensBefore, ...(policy ? { policy } : {}) }).trigger ?? undefined;

/** The budgets of a compaction at TRIGGER, with OVERHEAD it cannot remove. */
export const compactionBudgets = (trigger?: number, overheadTokens = 0, withWorkingSet = true): CompactionBudgets =>
  one({ ruleName: "omp", ...(trigger !== undefined ? { trigger } : {}), overheadTokens, workingSet: withWorkingSet }).budgets;

/** The budgets from before the window was known: still a ~128K window's. */
export const DEFAULT_BUDGETS: CompactionBudgets = compactionBudgets(undefined);
export const DEFAULT_SUMMARY_LIMITS: SummaryLimits = DEFAULT_BUDGETS.summary;
/** omp re-compacts unless the result lands at or under this share of the trigger (lisp/src/window.lisp). */
export const RECOVERY_BAND = 0.8;

/** The learned-limits file beside the config, read and written alone (op limits). */
export const recordLearnedWindow = (dir: string, key: string, contextWindow: number): boolean =>
  core({ op: "limits", action: "learn", key, dir, window: contextWindow }).recorded === true;
export const learnedWindow = (dir: string, key: string): number | undefined =>
  (core({ op: "limits", action: "learned", key, dir }).window as number | null | undefined) ?? undefined;
export interface WindowInfo { host?: number; learned?: number; effective?: number; source: string }
/** The window keel sizes for: the host's, or the smaller one an overflow error stated. */
export const windowOf = (model: { provider?: string; id?: string; contextWindow?: number } | undefined, hostName: string, dir: string): WindowInfo =>
  core({ op: "limits", action: "window", model: model ?? null, hostName, dir }).window as WindowInfo;
