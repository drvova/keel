// The model's context window as omp-vcc sizes compactions by, and the cases
// where omp-vcc compacts on its own because the host's trigger is above the real limit.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { modelKey, recordLearnedWindow, type WindowInfo } from "../core/model-limits";
import { handlesHostCompactions } from "../core/settings";
import { limitFromOverflowError, type TriggerRule } from "../core/window";
import { compactAndWait, tell, type Binding, type CompactionTrigger } from "../host";
import { isRecoveryReason, type CompactionReason } from "../types";

/** What window tracking learns over a binding's sessions, and the compaction it starts itself. */
export interface WindowState {
  /** The host's compaction policy as the last compaction carried it (preparation.settings, read by its TriggerRule), for this model. */
  hostPolicy: { key: string | undefined; policy: object } | null;
  /** The compaction omp-vcc started itself, so the hook records why. */
  selfTrigger: CompactionTrigger | null;
  /** The note that the host's window is above the real one was shown. */
  windowNoticeShown: boolean;
}

export const createWindowState = (): WindowState => ({
  hostPolicy: null,
  selfTrigger: null,
  windowNoticeShown: false,
});

/** The host's window is above the real one, so its trigger cannot fire before an overflow. */
const hostOverestimates = (w: WindowInfo): boolean =>
  w.host !== undefined && w.effective !== undefined && w.effective < w.host;

/** The host's policy for this model as the last compaction carried it; undefined before one, or for another model. */
const knownHostPolicy = (state: WindowState, key: string | undefined): object | undefined =>
  state.hostPolicy && state.hostPolicy.key === key ? state.hostPolicy.policy : undefined;

const positive = (n: number | undefined): number | undefined => (typeof n === "number" && n > 0 ? n : undefined);

/**
 * Where this compaction's budgets assume the next one happens: the host's
 * policy, which every compaction of either host carries (preparation.settings,
 * required from omp 18.14 and Pi 1.0 on), applied to the effective window as
 * the host applies it (`rule`: omp its threshold, reserve and the model's own
 * entry, Pi its reserve). When the host's window is too high, its trigger can
 * never fire, and the same policy on the real window applies. An overflow pass
 * is bounded by the context that overflowed. The policy is kept for the check
 * at the end of a run, which has none (registerWindowTracking).
 */
export const triggerFor = (
  w: WindowInfo,
  state: WindowState,
  key: string | undefined,
  reason: CompactionReason,
  tokensBefore: number | undefined,
  policy: object | undefined,
  rule: TriggerRule,
): number | undefined => {
  if (policy) state.hostPolicy = { key, policy };
  const trigger = w.effective ? rule.trigger(w.effective, policy) : undefined;
  const before = positive(tokensBefore);
  return isRecoveryReason(reason) && before ? (trigger ? Math.min(trigger, before) : before) : trigger;
};

/**
 * Learn limits from overflow errors, and compact when a run ends past omp-vcc's
 * own trigger on a model whose window the host overestimates (the host would
 * only notice at the overflow).
 */
export const registerWindowTracking = (pi: ExtensionAPI, state: WindowState, host: Pick<Binding, "rule" | "settledEvent" | "displayName" | "modelsFile" | "config" | "window">): void => {
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
    // The host's own compaction would run instead of omp-vcc's: none was asked for.
    if (!handlesHostCompactions(host.config.load(), ctx?.model?.provider)) return;
    const w = host.window(ctx?.model);
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
        tell(
          ctx,
          `omp-vcc: ${modelKey(ctx.model)} holds ${w.effective} tokens (an overflow error said so), not the ${w.host} ${host.displayName} uses; ` +
            `omp-vcc compacts at ${trigger}. Set its contextWindow in ${host.modelsFile} to make ${host.displayName} do the same.`,
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
