// The model's context window as omp-vcc learns it from the provider's overflow
// errors, and the cases where omp-vcc compacts on its own because the host's
// trigger is above the real limit. The core decides (lisp/src/host.lisp, ops
// learn-limit and settled; lisp/src/limits.lisp); this binds it to the host's events.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { compactAndWait, tell, type Binding, type CompactionTrigger } from "../host";
import { core } from "../core/lisp-core";
import { whenCore } from "../core/core-wait";
import { hostSnapshot } from "../core/host-snapshot";

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

/**
 * Learn limits from overflow errors, and compact when a run ends past omp-vcc's
 * own trigger on a model whose window the host overestimates (the host would
 * only notice at the overflow).
 */
export const registerWindowTracking = (pi: ExtensionAPI, state: WindowState, host: Pick<Binding, "name" | "displayName" | "modelsFile" | "settledEvent" | "config">): void => {
  // One compaction of omp-vcc's own at a time, per binding.
  let scheduled = false;

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; errorClassificationMessage?: string };
    if (message?.role !== "assistant" || message.stopReason !== "error") return;
    whenCore(() => core({ op: "learn-limit", host: hostSnapshot(host, ctx), errors: [message.errorMessage, message.errorClassificationMessage].filter((e) => typeof e === "string") }));
  });

  const onSettled = (event: { willContinue?: boolean; aborted?: boolean } | undefined, ctx: any) => {
    if (event?.willContinue || event?.aborted || scheduled) return;
    // While the core is not there yet, omp-vcc does not compact in the host's stead.
    const decided = whenCore(() => core({ op: "settled", host: hostSnapshot(host, ctx) }).settled as { notice: string } | null | undefined);
    if (!decided) return;
    if (!state.windowNoticeShown) {
      state.windowNoticeShown = true;
      tell(ctx, decided.notice);
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
