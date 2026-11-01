// The compaction hook's view of omp.
import type { CompactionHost } from "../hooks/compaction";
import type { CompactionReason } from "../types";
import type { OmpAutoCompactionStartEvent, OmpExtensionAPI } from "./api";

type TriggerContext = { reason: CompactionReason; willRetry: boolean };

/**
 * omp's session_before_compact carries no trigger. Every automatic pass emits
 * auto_compaction_start (and awaits its handlers) right before the hook, so
 * remember its reason for the next hook run. A hook run with none pending is a
 * manual one (/compact, /pi-vcc, ctx.compact()). omp retries the failed turn
 * after an overflow or a cut-off ("incomplete") reply, never after threshold or
 * idle maintenance.
 */
export const trackOmpCompactionTrigger = (pi: OmpExtensionAPI): (() => TriggerContext) => {
  let pending: TriggerContext | undefined;
  pi.on("auto_compaction_start", (event: OmpAutoCompactionStartEvent) => {
    const reason = event?.reason;
    pending = {
      reason: reason === "overflow" || reason === "idle" || reason === "incomplete" ? reason : "threshold",
      willRetry: reason === "overflow" || reason === "incomplete",
    };
  });
  pi.on("auto_compaction_end", () => {
    pending = undefined;
  });
  // Read once per hook run: a pass that ends without auto_compaction_end must
  // not leave its reason behind for a later manual compaction.
  return () => {
    const context = pending ?? { reason: "manual", willRetry: false };
    pending = undefined;
    return context;
  };
};

/**
 * No shouldAutoContinue: omp resumes the run itself after automatic maintenance
 * (`compaction.autoContinue`), so pi-vcc registers no continue of its own there.
 */
export const createOmpCompactionHost = (
  pi: OmpExtensionAPI,
  compactionContext: () => TriggerContext,
): CompactionHost => ({
  convertToLlm: (messages) => pi.pi.convertToLlm(messages),
  compactionContext,
});
