// The model's context window as omp-vcc sizes compactions by, and the cases
// where omp-vcc compacts on its own because the host's trigger is above the real limit.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { learnedWindow, modelKey, recordLearnedWindow, type ModelLike } from "../core/model-limits";
import type { Config } from "../core/settings";
import { effectiveWindow, limitFromOverflowError, type TriggerRule } from "../core/window";
import { compactAndWait, type CompactionTrigger, type HostName, type HostProfile } from "../host";
import { isRecoveryReason, type CompactionReason } from "../types";

/** What window tracking learns over a binding's sessions, and the compaction it starts itself. */
export interface WindowState {
  /** The host's trigger as the last threshold pass measured it (its tokensBefore), for this model. */
  measuredTrigger: { key: string; tokens: number } | null;
  /** The host's compaction policy as the last compaction carried it (preparation.settings, read by its TriggerRule), for this model. */
  hostPolicy: { key: string | undefined; policy: object } | null;
  /** The compaction omp-vcc started itself, so the hook records why. */
  selfTrigger: CompactionTrigger | null;
  /** The note that the host's window is above the real one was shown. */
  windowNoticeShown: boolean;
}

export const createWindowState = (): WindowState => ({
  measuredTrigger: null,
  hostPolicy: null,
  selfTrigger: null,
  windowNoticeShown: false,
});

interface WindowInfo {
  /** What the host uses (ctx.model.contextWindow; omp's discovery fills it from the provider, Pi's catalog and models.json). */
  host?: number;
  /** What an overflow error said, in this or an earlier session. */
  learned?: number;
  /** The smaller of them. */
  effective?: number;
  source: HostName | "overflow-error" | "unknown";
}

/** The window for this model: the host's, or the smaller one an overflow error stated (learned next to the config in `configDir`). */
export const windowOf = (model: ModelLike | undefined, hostName: HostName, configDir: string): WindowInfo => {
  const host = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined;
  const learned = learnedWindow(configDir, modelKey(model));
  const effective = effectiveWindow(host, learned);
  const source = effective === undefined ? "unknown"
    : effective === learned && learned !== host ? "overflow-error"
    : hostName;
  return { host, learned, effective, source };
};

/** The host's window is above the real one, so its trigger cannot fire before an overflow. */
const hostOverestimates = (w: WindowInfo): boolean =>
  w.host !== undefined && w.effective !== undefined && w.effective < w.host;

/** The host's policy for this model as the last compaction carried it; undefined before one, or for another model. */
const knownHostPolicy = (state: WindowState, key: string | undefined): object | undefined =>
  state.hostPolicy && state.hostPolicy.key === key ? state.hostPolicy.policy : undefined;

const positive = (n: number | undefined): number | undefined => (typeof n === "number" && n > 0 ? n : undefined);

/**
 * What a compaction tells about where the host compacts, kept for the later
 * ones: the policy the host handed it (`policy`, from preparation.settings),
 * or, from a host that sends none, a threshold pass's tokensBefore, which just
 * crossed the host's trigger.
 */
export const observeCompaction = (
  state: WindowState,
  w: WindowInfo,
  key: string | undefined,
  reason: CompactionReason,
  tokensBefore: number | undefined,
  policy: object | undefined,
): void => {
  if (policy) state.hostPolicy = { key, policy };
  const before = positive(tokensBefore);
  if (!hostOverestimates(w) && !(knownHostPolicy(state, key) && w.effective) && reason === "threshold" && before && key) {
    state.measuredTrigger = { key, tokens: before };
  }
};

/**
 * Where this compaction's budgets assume the next one happens, from what
 * observeCompaction kept: the host's policy applied to the effective window as
 * the host applies it (`rule`: omp its threshold, reserve and the model's own
 * entry, Pi its reserve). When the host's window is too high, its trigger can
 * never fire, and the same policy on the real window applies. Without a
 * policy, the trigger a threshold pass measured, else the host's default. An
 * overflow pass is bounded by the context that overflowed.
 */
export const triggerFor = (
  w: WindowInfo,
  state: WindowState,
  key: string | undefined,
  reason: CompactionReason,
  tokensBefore: number | undefined,
  rule: TriggerRule,
): number | undefined => {
  const before = positive(tokensBefore);
  const known = knownHostPolicy(state, key);
  const bounded = (t: number | undefined) =>
    isRecoveryReason(reason) && before ? (t ? Math.min(t, before) : before) : t;
  if (hostOverestimates(w)) return bounded(rule.trigger(w.effective!, known));
  if (known && w.effective) return bounded(rule.trigger(w.effective, known));
  const measured = state.measuredTrigger?.key === key ? state.measuredTrigger?.tokens : undefined;
  return bounded(measured ?? (w.effective ? rule.trigger(w.effective) : undefined));
};

/**
 * Learn limits from overflow errors, and compact when a run ends past omp-vcc's
 * own trigger on a model whose window the host overestimates (the host would
 * only notice at the overflow).
 */
export const registerWindowTracking = (pi: ExtensionAPI, state: WindowState, host: HostProfile & { config: Config }): void => {
  // One compaction of omp-vcc's own at a time, per binding.
  let scheduled = false;

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; errorClassificationMessage?: string };
    if (message?.role !== "assistant" || message.stopReason !== "error") return;
    const limit = limitFromOverflowError(message.errorMessage) ?? limitFromOverflowError(message.errorClassificationMessage);
    const hostWindow = ctx?.model?.contextWindow;
    if (limit && (typeof hostWindow !== "number" || !(hostWindow > 0) || limit < hostWindow)) recordLearnedWindow(host.config.dir(), modelKey(ctx?.model), limit);
  });

  const onSettled = (event: { willContinue?: boolean; aborted?: boolean } | undefined, ctx: any) => {
    if (event?.willContinue || event?.aborted || scheduled) return;
    if (!host.config.load().overrideDefaultCompaction) return;
    const w = windowOf(ctx?.model, host.name, host.config.dir());
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
        void compactAndWait(ctx).finally(done);
      } catch {
        done();
      }
    }, 0);
  };
  pi.on(host.settledEvent as "agent_end", onSettled as any);
};
