// omp as a host of keel, built from what omp hands an extension (`pi.pi`),
// so nothing here imports an omp package at runtime.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MANUAL_TRIGGER, OMP_HOST, type CompactionTrigger, type Host } from "../host";

/**
 * omp's session_before_compact carries no trigger. Every automatic pass emits
 * auto_compaction_start (and awaits its handlers) right before the hook, so
 * remember its reason for the next hook run. A hook run with none pending is a
 * manual one (/compact, /keel, ctx.compact()). omp retries the failed turn
 * after an overflow or a cut-off ("incomplete") reply, never after threshold or
 * idle maintenance.
 */
const trackOmpCompactionTrigger = (pi: ExtensionAPI): (() => CompactionTrigger) => {
  let pending: CompactionTrigger | undefined;
  pi.on("auto_compaction_start", (event) => {
    const reason = event?.reason;
    pending = {
      reason: reason === "overflow" || reason === "idle" || reason === "incomplete" ? reason : "threshold",
      // omp retries the turn after an overflow or a cut-off reply, never after threshold or idle maintenance.
      willRetry: reason === "overflow" || reason === "incomplete",
    };
  });
  pi.on("auto_compaction_end", () => {
    pending = undefined;
  });
  // Read once per hook run: a pass that ends without auto_compaction_end must
  // not leave its reason behind for a later manual compaction.
  return () => {
    const trigger = pending ?? MANUAL_TRIGGER;
    pending = undefined;
    return trigger;
  };
};

/**
 * omp: its own convertToLlm and agent directory from `pi.pi`. No continue of
 * keel's own: omp resumes the run itself after automatic maintenance
 * (`compaction.autoContinue`).
 */
export const ompHost = (pi: ExtensionAPI): Host => {
  const trigger = trackOmpCompactionTrigger(pi);
  return {
    ...OMP_HOST,
    convertToLlm: (messages) => pi.pi.convertToLlm(messages),
    agentDir: () => pi.pi.getAgentDir(),
    triggerOf: () => trigger(),
  };
};
