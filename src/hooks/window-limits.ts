// The model's context window as omp-vcc sizes compactions by, and the cases
// where omp-vcc compacts on its own because the host's trigger is above the real limit.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { learnedHostPolicy, modelKey, recordLearnedWindow, type WindowInfo } from "../core/model-limits";
import { handlesHostCompactions } from "../core/settings";
import { limitFromOverflowError, triggerFor } from "../core/window";
import { compactAndWait, tell, type Binding, type CompactionTrigger } from "../host";

/** What window tracking learns over a binding's sessions, and the compaction it starts itself. */
export interface WindowState {
  /** The compaction omp-vcc started itself, so the hook records why. */
  selfTrigger: CompactionTrigger | null;
  /** The note that the host's window is above the real one was shown. */
  windowNoticeShown: boolean;
}

export const createWindowState = (): WindowState => ({
  selfTrigger: null,
  windowNoticeShown: false,
});

/** The host's window is above the real one, so its trigger cannot fire before an overflow. */
const hostOverestimates = (w: WindowInfo): boolean =>
  w.host !== undefined && w.effective !== undefined && w.effective < w.host;

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
    // The host's own policy, as a compaction last carried it for this model (in
    // this session or an earlier one): a user who turned the host's automatic
    // compaction off gets none from omp-vcc either, and a threshold of theirs
    // applies to the real window. Until one has, omp-vcc does not compact in
    // the host's stead: it cannot know the user wants it.
    const policy = learnedHostPolicy(host.config.dir(), modelKey(ctx?.model));
    if (!policy || !host.rule.autoCompacts(policy)) return;
    // The trigger as the hook works it out for the pass this starts (which cancels when the context is under it).
    const trigger = triggerFor(w.effective, false, undefined, policy, host.rule);
    if (trigger === undefined) return;
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
