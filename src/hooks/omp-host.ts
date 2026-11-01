// The compaction hook's view of omp.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { CompactionHost, CompactionTrigger } from "./compaction";

/**
 * omp's session_before_compact carries no trigger. Every automatic pass emits
 * auto_compaction_start (and awaits its handlers) right before the hook, so
 * remember its reason for the next hook run. A hook run with none pending is a
 * manual one (/compact, /omp-vcc, ctx.compact()). omp retries the failed turn
 * after an overflow or a cut-off ("incomplete") reply, never after threshold or
 * idle maintenance.
 */
export const trackOmpCompactionTrigger = (pi: ExtensionAPI): (() => CompactionTrigger) => {
  let pending: CompactionTrigger | undefined;
  pi.on("auto_compaction_start", (event) => {
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
    const trigger = pending ?? { reason: "manual", willRetry: false };
    pending = undefined;
    return trigger;
  };
};

/**
 * omp's own convertToLlm, read from pi.pi so the extension imports no omp
 * package at runtime. No continue of omp-vcc's own: omp resumes the run itself
 * after automatic maintenance (`compaction.autoContinue`).
 */
export const createOmpCompactionHost = (
  pi: ExtensionAPI,
  compactionTrigger: () => CompactionTrigger,
): CompactionHost => ({
  convertToLlm: (messages) => pi.pi.convertToLlm(messages),
  compactionTrigger,
});
