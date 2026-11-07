// The model's context window as omp-vcc sizes compactions by, and the cases
// where omp-vcc compacts on its own because the host's trigger is above the
// real limit. The core decides (lisp/src/window.lisp, op window; lisp/src/limits.lisp, op limits);
// this binds it to the host's events.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { learnWindow } from "../core/model-limits";
import { compactAndWait, tell, type Binding, type CompactionTrigger } from "../host";
import { core, CoreUnavailable } from "../core/lisp-core";
import { whenCore } from "../core/core-wait";

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

/** The first limit the error texts state. */
const overflowLimit = (texts: unknown[]): number | undefined =>
  (core({ op: "window", cases: texts.map((error) => ({ error: error ?? null })) }).results as Array<{ limit?: number }>)
    .map((r) => r.limit)
    .find((n) => n !== undefined);

/**
 * Once a run settles, whether omp-vcc compacts in the host's stead: the host's
 * window is above the real one, its policy as a compaction last carried it for
 * this model compacts, and the context is past the trigger. The notice says so,
 * or null when it does not.
 */
const settled = (host: Pick<Binding, "rule" | "displayName" | "modelsFile" | "config" | "name">, ctx: any): { notice: string } | null => {
  const m = ctx?.model;
  const reply = core({
    op: "limits", action: "settled", dir: host.config.dir(), configPath: host.config.path(), provider: m?.provider ?? null,
    model: m ? { provider: m.provider, id: m.id, contextWindow: m.contextWindow } : null, ruleName: host.rule.name, hostName: host.name,
    displayName: host.displayName, modelsFile: host.modelsFile, usedTokens: ctx?.getContextUsage?.()?.tokens ?? null,
  });
  return (reply.settled as { notice: string } | undefined) ?? null;
};

/**
 * Learn limits from overflow errors, and compact when a run ends past omp-vcc's
 * own trigger on a model whose window the host overestimates (the host would
 * only notice at the overflow).
 */
export const registerWindowTracking = (pi: ExtensionAPI, state: WindowState, host: Pick<Binding, "rule" | "settledEvent" | "displayName" | "modelsFile" | "config" | "name">): void => {
  // One compaction of omp-vcc's own at a time, per binding.
  let scheduled = false;

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; errorClassificationMessage?: string };
    if (message?.role !== "assistant" || message.stopReason !== "error") return;
    whenCore(() => {
      const limit = overflowLimit([message.errorMessage, message.errorClassificationMessage]);
      const hostWindow = ctx?.model?.contextWindow;
      if (limit && (typeof hostWindow !== "number" || !(hostWindow > 0) || limit < hostWindow)) learnWindow(host.config.dir(), ctx?.model, limit);
    });
  });

  const onSettled = (event: { willContinue?: boolean; aborted?: boolean } | undefined, ctx: any) => {
    if (event?.willContinue || event?.aborted || scheduled) return;
    let decided: { notice: string } | null;
    try {
      decided = settled(host, ctx);
    } catch (err) {
      // While the core is not there yet, omp-vcc does not compact in the host's stead.
      if (err instanceof CoreUnavailable) return;
      throw err;
    }
    if (!decided) return;
    if (!state.windowNoticeShown) {
      state.windowNoticeShown = true;
      try { tell(ctx, decided.notice); } catch {}
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
