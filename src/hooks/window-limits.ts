// The model's context window as omp-vcc sizes compactions by, and the cases
// where omp-vcc compacts on its own because the host's trigger is above the real limit.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { learnedHostPolicy, learnWindow, modelKey, type WindowInfo } from "../core/model-limits";
import { handlesHostCompactions } from "../core/settings";
import { limitFromOverflowError, triggerFor, type TriggerRule } from "../core/window";
import { compactAndWait, tell, type Binding, type CompactionTrigger } from "../host";
import { callCore } from "../core/lisp-core";

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

/** The window rules in the Lisp core (lisp/src/window.lisp, op window), case by case; undefined without it. */
const windowInCore = (cases: object[]): Array<Record<string, any>> | undefined =>
  callCore({ op: "window", cases })?.results as Array<Record<string, any>> | undefined;

/** The first limit the error texts state. */
const overflowLimit = (texts: unknown[]): number | undefined => {
  const inCore = windowInCore(texts.map((error) => ({ error: error ?? null })));
  return (inCore ? inCore.map((r) => r.limit as number | undefined) : texts.map(limitFromOverflowError)).find((n) => n !== undefined);
};

/** Whether the host compacts on its own under `policy`, and where on `window`. */
const hostTrigger = (rule: TriggerRule, window: number | undefined, policy: object): { autoCompacts: boolean; trigger: number | undefined } => {
  const inCore = windowInCore([{ ruleName: rule.name, window, policy }])?.[0];
  if (inCore) return { autoCompacts: inCore.autoCompacts === true, trigger: inCore.trigger };
  return { autoCompacts: rule.autoCompacts(policy), trigger: triggerFor(window, false, undefined, policy, rule) };
};

/**
 * The Lisp core's decision once a run settles (lisp/src/limits.lisp, op limits
 * action settled): the notice when omp-vcc compacts in the host's stead, null
 * when it does not, undefined without the core.
 */
const settledInCore = (host: Pick<Binding, "rule" | "displayName" | "modelsFile" | "config" | "name">, ctx: any): { notice: string } | null | undefined => {
  const m = ctx?.model;
  const reply = callCore({
    op: "limits", action: "settled", dir: host.config.dir(), configPath: host.config.path(), provider: m?.provider ?? null,
    model: m ? { provider: m.provider, id: m.id, contextWindow: m.contextWindow } : null, ruleName: host.rule.name, hostName: host.name,
    displayName: host.displayName, modelsFile: host.modelsFile, usedTokens: ctx?.getContextUsage?.()?.tokens ?? null,
  });
  if (!reply) return undefined;
  return (reply.settled as { notice: string } | undefined) ?? null;
};

/** The host's window is above the real one, so its trigger cannot fire before an overflow. */
const hostOverestimates = (w: WindowInfo): boolean =>
  w.host !== undefined && w.effective !== undefined && w.effective < w.host;

/**
 * Learn limits from overflow errors, and compact when a run ends past omp-vcc's
 * own trigger on a model whose window the host overestimates (the host would
 * only notice at the overflow).
 */
export const registerWindowTracking = (pi: ExtensionAPI, state: WindowState, host: Pick<Binding, "rule" | "settledEvent" | "displayName" | "modelsFile" | "config" | "window" | "name">): void => {
  // One compaction of omp-vcc's own at a time, per binding.
  let scheduled = false;

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; errorClassificationMessage?: string };
    if (message?.role !== "assistant" || message.stopReason !== "error") return;
    const limit = overflowLimit([message.errorMessage, message.errorClassificationMessage]);
    const hostWindow = ctx?.model?.contextWindow;
    if (limit && (typeof hostWindow !== "number" || !(hostWindow > 0) || limit < hostWindow)) learnWindow(host.config.dir(), ctx?.model, limit);
  });

  const onSettled = (event: { willContinue?: boolean; aborted?: boolean } | undefined, ctx: any) => {
    if (event?.willContinue || event?.aborted || scheduled) return;
    const decided = settledInCore(host, ctx);
    if (decided !== undefined) {
      if (!decided) return;
      return compactInHostsStead(ctx, decided.notice);
    }
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
    if (!policy) return;
    // The trigger as the hook works it out for the pass this starts (which cancels when the context is under it).
    const { autoCompacts, trigger } = hostTrigger(host.rule, w.effective, policy);
    if (!autoCompacts || trigger === undefined) return;
    const used = ctx?.getContextUsage?.()?.tokens;
    if (!(typeof used === "number" && used >= trigger)) return;
    compactInHostsStead(ctx,
      `omp-vcc: ${modelKey(ctx.model)} holds ${w.effective} tokens (an overflow error said so), not the ${w.host} ${host.displayName} uses; ` +
        `omp-vcc compacts at ${trigger}. Set its contextWindow in ${host.modelsFile} to make ${host.displayName} do the same.`);
  };

  /** Tell why once per binding, then compact once the host is idle. */
  const compactInHostsStead = (ctx: any, notice: string) => {
    if (!state.windowNoticeShown) {
      state.windowNoticeShown = true;
      try { tell(ctx, notice); } catch {}
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
