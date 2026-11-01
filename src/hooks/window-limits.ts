// The model's context window as omp-vcc sizes compactions by, and the cases
// where omp-vcc compacts on its own because omp's trigger is above the real limit.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { learnedWindow, modelKey, providerWindow, recordLearnedWindow, startProviderProbe, type ModelLike } from "../core/model-limits";
import { loadSettings } from "../core/settings";
import { effectiveWindow, limitFromOverflowError, ompAutoCompacts, ompTrigger, type OmpCompactionPolicy } from "../core/window";
import type { CompactionState } from "./compaction";

export interface WindowInfo {
  /** What omp uses (ctx.model.contextWindow). */
  omp?: number;
  /** What the provider's /models says. */
  provider?: number;
  /** What an overflow error said, in this or an earlier session. */
  learned?: number;
  /** The smallest of them. */
  effective?: number;
  source: "omp" | "provider" | "overflow-error" | "unknown";
}

export const windowOf = (model: ModelLike | undefined): WindowInfo => {
  const omp = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined;
  const provider = providerWindow(model);
  const learned = learnedWindow(modelKey(model));
  const effective = effectiveWindow(omp, provider, learned);
  const source = effective === undefined ? "unknown"
    : effective === learned && learned !== omp ? "overflow-error"
    : effective === provider && provider !== omp ? "provider"
    : "omp";
  return { omp, provider, learned, effective, source };
};

/** omp's window is above the real one, so its trigger cannot fire before an overflow. */
export const ompOverestimates = (w: WindowInfo): boolean =>
  w.omp !== undefined && w.effective !== undefined && w.effective < w.omp;

/** omp's policy for this model as the last compaction carried it; undefined before one, or for another model. */
export const knownOmpPolicy = (state: CompactionState, key: string | undefined): OmpCompactionPolicy | undefined =>
  state.ompPolicy && state.ompPolicy.key === key ? state.ompPolicy.policy : undefined;

/**
 * Where this compaction's budgets assume the next one happens. omp hands its
 * compaction policy to every compaction (`policy`, from preparation.settings):
 * its threshold, reserve and the model's own entry, applied to the effective
 * window as omp applies them (ompTrigger). When omp's window is too high, its
 * trigger can never fire, and the same policy on the real window applies.
 * Without a policy (an omp that sends none): a threshold pass measures omp's
 * trigger (its tokensBefore just crossed it), otherwise omp's default. An
 * overflow pass is bounded by the context that overflowed.
 */
export const triggerFor = (
  w: WindowInfo,
  state: CompactionState,
  key: string | undefined,
  reason: string,
  tokensBefore: number | undefined,
  policy?: OmpCompactionPolicy,
): number | undefined => {
  const before = typeof tokensBefore === "number" && tokensBefore > 0 ? tokensBefore : undefined;
  if (policy) state.ompPolicy = { key, policy };
  const known = policy ?? knownOmpPolicy(state, key);
  const bounded = (t: number | undefined) =>
    (reason === "overflow" || reason === "incomplete") && before ? (t ? Math.min(t, before) : before) : t;
  if (ompOverestimates(w)) return bounded(ompTrigger(w.effective!, known));
  if (known && w.effective) return bounded(ompTrigger(w.effective, known));
  if (reason === "threshold" && before && key) {
    state.measuredTrigger = { key, tokens: before };
    return before;
  }
  const measured = state.measuredTrigger?.key === key ? state.measuredTrigger?.tokens : undefined;
  return bounded(measured ?? (w.effective ? ompTrigger(w.effective) : undefined));
};

const describe = (w: WindowInfo): string =>
  w.source === "provider" ? "its provider's /models says so"
  : w.source === "overflow-error" ? "an overflow error said so"
  : "";

/**
 * Learn limits from overflow errors, ask the provider for the window in the
 * background, and compact when a run ends past omp-vcc's own trigger on a model
 * whose window omp overestimates (omp would only notice at the overflow).
 */
export const registerWindowTracking = (pi: ExtensionAPI, state: CompactionState): void => {
  // One compaction of omp-vcc's own at a time, per binding.
  let scheduled = false;
  const probe = (ctx: any) => {
    try {
      if (loadSettings().probeProviderWindow) startProviderProbe(ctx?.model, ctx?.modelRegistry);
    } catch {}
  };
  pi.on("session_start", (_event, ctx) => probe(ctx));
  pi.on("before_agent_start", (_event, ctx) => probe(ctx));

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; errorClassificationMessage?: string };
    if (message?.role !== "assistant" || message.stopReason !== "error") return;
    const limit = limitFromOverflowError(message.errorMessage) ?? limitFromOverflowError(message.errorClassificationMessage);
    const omp = ctx?.model?.contextWindow;
    if (limit && (typeof omp !== "number" || !(omp > 0) || limit < omp)) recordLearnedWindow(modelKey(ctx?.model), limit);
  });

  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue || scheduled) return;
    let settings;
    try {
      settings = loadSettings();
    } catch {
      return;
    }
    if (!settings.overrideDefaultCompaction) return;
    const w = windowOf(ctx?.model);
    if (!ompOverestimates(w)) return;
    // omp's own policy, once a compaction has carried it: a user who turned omp's
    // automatic compaction off gets none from omp-vcc either, and a threshold of
    // theirs applies to the real window.
    const policy = knownOmpPolicy(state, modelKey(ctx?.model));
    if (!ompAutoCompacts(policy)) return;
    const trigger = ompTrigger(w.effective!, policy);
    const used = ctx?.getContextUsage?.()?.tokens;
    if (!(typeof used === "number" && used >= trigger)) return;
    if (!state.windowNoticeShown) {
      state.windowNoticeShown = true;
      try {
        ctx.ui?.notify?.(
          `omp-vcc: ${modelKey(ctx.model)} holds ${w.effective} tokens (${describe(w)}), not the ${w.omp} omp uses; ` +
            `omp-vcc compacts at ${trigger}. Set its contextWindow in omp's models.yml to make omp do the same.`,
          "info",
        );
      } catch {}
    }
    // After this handler returns, once omp is idle: compacting from inside agent_end would race its settle.
    scheduled = true;
    setTimeout(() => {
      const done = () => {
        state.selfTrigger = null;
        scheduled = false;
      };
      try {
        if (ctx.isIdle?.() === false) return done();
        state.selfTrigger = { reason: "threshold", willRetry: false };
        void Promise.resolve(ctx.compact({ onError: () => {} })).catch(() => {}).finally(done);
      } catch {
        done();
      }
    }, 0);
  });
};
