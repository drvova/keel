// The model's context window as omp-vcc sizes compactions by, and the cases
// where omp-vcc compacts on its own because the host's trigger is above the real limit.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { learnedWindow, modelKey, recordLearnedWindow, type ModelLike } from "../core/model-limits";
import { loadSettings } from "../core/settings";
import { effectiveWindow, limitFromOverflowError, OMP_TRIGGER_RULE, type TriggerRule } from "../core/window";
import { OMP_HOST, type HostName, type HostProfile } from "../host";
import type { CompactionState } from "./compaction";

export interface WindowInfo {
  /** What the host uses (ctx.model.contextWindow; omp's discovery fills it from the provider, Pi's catalog and models.json). */
  host?: number;
  /** What an overflow error said, in this or an earlier session. */
  learned?: number;
  /** The smaller of them. */
  effective?: number;
  source: HostName | "overflow-error" | "unknown";
}

export const windowOf = (model: ModelLike | undefined, hostName: HostName = "omp"): WindowInfo => {
  const host = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined;
  const learned = learnedWindow(modelKey(model));
  const effective = effectiveWindow(host, learned);
  const source = effective === undefined ? "unknown"
    : effective === learned && learned !== host ? "overflow-error"
    : hostName;
  return { host, learned, effective, source };
};

/** The host's window is above the real one, so its trigger cannot fire before an overflow. */
export const hostOverestimates = (w: WindowInfo): boolean =>
  w.host !== undefined && w.effective !== undefined && w.effective < w.host;

/** The host's policy for this model as the last compaction carried it; undefined before one, or for another model. */
export const knownHostPolicy = (state: CompactionState, key: string | undefined): object | undefined =>
  state.hostPolicy && state.hostPolicy.key === key ? state.hostPolicy.policy : undefined;

/**
 * Where this compaction's budgets assume the next one happens. The host hands
 * its compaction policy to every compaction (`policy`, from
 * preparation.settings): omp its threshold, reserve and the model's own entry,
 * Pi its reserve, applied to the effective window as the host applies them
 * (`rule`). When the host's window is too high, its trigger can never fire, and
 * the same policy on the real window applies. Without a policy (a host that
 * sends none): a threshold pass measures the host's trigger (its tokensBefore
 * just crossed it), otherwise the host's default. An overflow pass is bounded
 * by the context that overflowed.
 */
export const triggerFor = (
  w: WindowInfo,
  state: CompactionState,
  key: string | undefined,
  reason: string,
  tokensBefore: number | undefined,
  policy?: object,
  rule: TriggerRule = OMP_TRIGGER_RULE,
): number | undefined => {
  const before = typeof tokensBefore === "number" && tokensBefore > 0 ? tokensBefore : undefined;
  if (policy) state.hostPolicy = { key, policy };
  const known = policy ?? knownHostPolicy(state, key);
  const bounded = (t: number | undefined) =>
    (reason === "overflow" || reason === "incomplete") && before ? (t ? Math.min(t, before) : before) : t;
  if (hostOverestimates(w)) return bounded(rule.trigger(w.effective!, known));
  if (known && w.effective) return bounded(rule.trigger(w.effective, known));
  if (reason === "threshold" && before && key) {
    state.measuredTrigger = { key, tokens: before };
    return before;
  }
  const measured = state.measuredTrigger?.key === key ? state.measuredTrigger?.tokens : undefined;
  return bounded(measured ?? (w.effective ? rule.trigger(w.effective) : undefined));
};

/**
 * Learn limits from overflow errors, and compact when a run ends past omp-vcc's
 * own trigger on a model whose window the host overestimates (the host would
 * only notice at the overflow).
 */
export const registerWindowTracking = (pi: ExtensionAPI, state: CompactionState, host: HostProfile = OMP_HOST): void => {
  // One compaction of omp-vcc's own at a time, per binding.
  let scheduled = false;

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; errorClassificationMessage?: string };
    if (message?.role !== "assistant" || message.stopReason !== "error") return;
    const limit = limitFromOverflowError(message.errorMessage) ?? limitFromOverflowError(message.errorClassificationMessage);
    const hostWindow = ctx?.model?.contextWindow;
    if (limit && (typeof hostWindow !== "number" || !(hostWindow > 0) || limit < hostWindow)) recordLearnedWindow(modelKey(ctx?.model), limit);
  });

  const onSettled = (event: { willContinue?: boolean; aborted?: boolean } | undefined, ctx: any) => {
    if (event?.willContinue || event?.aborted || scheduled) return;
    let settings;
    try {
      settings = loadSettings();
    } catch {
      return;
    }
    if (!settings.overrideDefaultCompaction) return;
    const w = windowOf(ctx?.model, host.name);
    if (!hostOverestimates(w)) return;
    // The host's own policy, once a compaction has carried it: a user who turned
    // the host's automatic compaction off gets none from omp-vcc either, and a
    // threshold of theirs applies to the real window.
    const policy = knownHostPolicy(state, modelKey(ctx?.model));
    if (!host.rule.autoCompacts(policy)) return;
    const trigger = host.rule.trigger(w.effective!, policy);
    const used = ctx?.getContextUsage?.()?.tokens;
    if (!(typeof used === "number" && used >= trigger)) return;
    if (!state.windowNoticeShown) {
      state.windowNoticeShown = true;
      try {
        ctx.ui?.notify?.(
          `omp-vcc: ${modelKey(ctx.model)} holds ${w.effective} tokens (an overflow error said so), not the ${w.host} ${host.displayName} uses; ` +
            `omp-vcc compacts at ${trigger}. Set its contextWindow in ${host.modelsFile} to make ${host.displayName} do the same.`,
          "info",
        );
      } catch {}
    }
    // After this handler returns, once the host is idle: compacting from inside the event would race its settle.
    scheduled = true;
    setTimeout(() => {
      const done = () => {
        state.selfTrigger = null;
        scheduled = false;
      };
      try {
        if (ctx.isIdle?.() === false) return done();
        state.selfTrigger = { reason: "threshold", willRetry: false };
        // omp's compact() settles with the compaction; Pi's starts it and reports through the callbacks.
        const settled = new Promise<void>((resolve) => {
          const r = ctx.compact({ onComplete: () => resolve(), onError: () => resolve() });
          if (r && typeof r.then === "function") Promise.resolve(r).then(() => resolve(), () => resolve());
        });
        void settled.catch(() => {}).finally(done);
      } catch {
        done();
      }
    }, 0);
  };
  pi.on(host.settledEvent as "agent_end", onSettled as any);
};
