// The model's context window as omp-vcc sizes compactions by, and the cases
// where omp-vcc compacts on its own because omp's trigger is above the real limit.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { learnedWindow, modelKey, providerWindow, recordLearnedWindow, startProviderProbe, type ModelLike } from "../core/model-limits";
import { loadSettings } from "../core/settings";
import { effectiveWindow, limitFromOverflowError, ompDefaultTrigger } from "../core/window";
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

/**
 * Where this compaction's budgets assume the next one happens. A threshold pass
 * measured omp's real trigger (its tokensBefore just crossed it); an overflow
 * pass is bounded by the context that overflowed; otherwise omp's default on
 * the effective window. When omp's window is too high, its own trigger is
 * meaningless, and omp-vcc's (ompDefaultTrigger of the real window) applies.
 */
export const triggerFor = (
  w: WindowInfo,
  state: CompactionState,
  key: string | undefined,
  reason: string,
  tokensBefore: number | undefined,
): number | undefined => {
  const before = typeof tokensBefore === "number" && tokensBefore > 0 ? tokensBefore : undefined;
  if (ompOverestimates(w)) return ompDefaultTrigger(w.effective!);
  if (reason === "threshold" && before && key) {
    state.measuredTrigger = { key, tokens: before };
    return before;
  }
  const measured = state.measuredTrigger?.key === key ? state.measuredTrigger?.tokens : undefined;
  const base = measured ?? (w.effective ? ompDefaultTrigger(w.effective) : undefined);
  if ((reason === "overflow" || reason === "incomplete") && before) return base ? Math.min(base, before) : before;
  return base;
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
    const trigger = ompDefaultTrigger(w.effective!);
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
