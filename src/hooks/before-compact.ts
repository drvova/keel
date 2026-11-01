// Pi binding of the compaction hook: the Pi host's functions, installed as the
// process default when this module loads. The hook itself is host-agnostic
// (./compaction); omp has its own binding in src/omp/.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, VERSION } from "@earendil-works/pi-coding-agent";
import * as piCore from "@earendil-works/pi-coding-agent";
import {
  registerCompactionHook,
  setDefaultCompactionHost,
  shouldScheduleAutoContinue,
  type CompactionHost,
} from "./compaction";

export * from "./compaction";

/**
 * `piVersion` decides whether pi-vcc's own continue is still needed after an
 * automatic compaction (Pi >= PI_SELF_RESUME_VERSION resumes by itself).
 */
export const createPiCompactionHost = (piVersion: string = VERSION): CompactionHost => ({
  convertToLlm: (messages) => convertToLlm(messages as any),
  // Read at call time: older supported Pi releases do not export it.
  get buildSessionProjection() {
    return (piCore as any).buildSessionProjection;
  },
  shouldAutoContinue: (settingEnabled) => shouldScheduleAutoContinue(settingEnabled, piVersion),
});

setDefaultCompactionHost(createPiCompactionHost());

/**
 * `piVersion` is the running Pi version (defaults to the runtime's own VERSION).
 * It is a parameter, not a setting: it decides whether pi-vcc's auto-continue
 * fallback is still needed, and lets tests pin the behaviour to a version.
 */
export const registerBeforeCompactHook = (pi: ExtensionAPI, piVersion: string = VERSION) =>
  registerCompactionHook(pi, createPiCompactionHost(piVersion));
