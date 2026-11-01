// omp's own context maintenance that works around omp-vcc, and how omp-vcc
// says so.
//
// omp walks `compaction.methodOrder` on every automatic pass. Each method but
// one asks the session_before_compact hook first and stands down when omp-vcc
// answers; `shake` runs inline before any hook (on an overflow it is the first
// usable method for a text-only model), and when omp-vcc steps aside the next
// method (snapcompact, handoff, server compaction) writes its own summary.
// `compaction.experimentalContextManagement` replaces compaction with a
// notes-backed rollover. `compaction.supersedeReads` and `compaction.dropUseless`
// blank tool results in the session file, which vcc_recall reads as the raw
// history.
//
// omp-vcc does not change omp's settings: an extension reaches them only
// through omp's settings registry, a package import, and omp-vcc imports none at
// runtime. It reads them where omp hands them over, in every compaction's
// `preparation.settings` (the model's whole compaction policy), and sees a
// shake in `auto_compaction_start`. Once per process, it names the settings that
// work around it, with the `omp config set` lines that change them
// (omp's settings.md); the user decides.
//
// Not covered by any setting: omp's age-based prune of old tool output (past
// the newest 40K tool tokens, when it frees 20K) runs before each threshold
// check, and its dead-end shake when a context stays above the recovery band.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadSettings, type VccSettings } from "../core/settings";

export interface OmpSettingAdvice {
  id: string;
  current: unknown;
  recommended: unknown;
  /** What it does around omp-vcc, for the notice. */
  why: string;
}

const METHODS_WITHOUT_OMP_VCC = "runs shake before omp-vcc on an overflow, and snapcompact, handoff or server compaction when it steps aside";

/** omp's settings that leave compaction to omp-vcc. `remote` stays for the providers omp-vcc defers to (skipForProviders). */
export const recommendedOmpSettings = (settings: Pick<VccSettings, "skipForProviders">): Array<Omit<OmpSettingAdvice, "current">> => [
  {
    id: "compaction.methodOrder",
    recommended: settings.skipForProviders.length > 0 ? ["remote", "soft"] : ["soft"],
    why: METHODS_WITHOUT_OMP_VCC,
  },
  { id: "compaction.experimentalContextManagement", recommended: false, why: "replaces compaction with a rollover" },
  { id: "compaction.supersedeReads", recommended: false, why: "blanks older reads in the session file vcc_recall reads" },
  { id: "compaction.dropUseless", recommended: false, why: "blanks tool results in the session file vcc_recall reads" },
];

/**
 * The settings in omp's `preparation.settings` that work around omp-vcc. A
 * method order works around it when it holds a method besides the recommended
 * ones; a key omp does not send is not judged.
 */
export const ompSettingsAdvice = (ompSettings: unknown, settings: Pick<VccSettings, "skipForProviders">): OmpSettingAdvice[] => {
  if (!ompSettings || typeof ompSettings !== "object") return [];
  const given = ompSettings as Record<string, unknown>;
  const advice: OmpSettingAdvice[] = [];
  for (const rec of recommendedOmpSettings(settings)) {
    const key = rec.id.slice("compaction.".length);
    if (!(key in given)) continue;
    const current = given[key];
    const differs = Array.isArray(rec.recommended)
      ? Array.isArray(current) && current.some((m) => !(rec.recommended as unknown[]).includes(m))
      : current === true;
    if (differs) advice.push({ ...rec, current });
  }
  return advice;
};

/** `omp config set` takes an array as JSON (omp's settings.md, value parsing). */
const configSetLine = (a: Pick<OmpSettingAdvice, "id" | "recommended">): string =>
  `omp config set ${a.id} ${Array.isArray(a.recommended) ? `'${JSON.stringify(a.recommended)}'` : String(a.recommended)}`;

export const ompSettingsNotice = (advice: OmpSettingAdvice[]): string =>
  `omp-vcc: omp's own maintenance still works around omp-vcc: ` +
  advice.map((a) => `${a.id} ${a.why}`).join("; ") +
  `. To leave it to omp-vcc, run ${advice.map(configSetLine).join(" and ")}, or change them in /settings (Context). ` +
  `"checkOmpSettings": false in omp-vcc's config hides this.`;

// One notice per process: omp's settings are one store, shared by every
// session's binding (subagents included).
let noticeShown = false;

/**
 * Called by the compaction hook with omp's settings: notify once when, while
 * omp-vcc handles compaction, they work around it.
 */
export const checkOmpSettings = (ompSettings: unknown, settings: VccSettings, ctx: unknown): void => {
  if (noticeShown || !settings.overrideDefaultCompaction || !settings.checkOmpSettings) return;
  const advice = ompSettingsAdvice(ompSettings, settings);
  if (advice.length === 0) return;
  noticeShown = true;
  try {
    (ctx as { ui?: { notify?: (m: string, l: string) => void } })?.ui?.notify?.(ompSettingsNotice(advice), "warning");
  } catch {}
};

/** An automatic shake is omp trimming tool output instead of letting omp-vcc compact. */
export const registerOmpSettingsCheck = (pi: ExtensionAPI): void => {
  pi.on("auto_compaction_start", (event, ctx) => {
    if ((event as { action?: string }).action !== "shake" || noticeShown) return;
    let settings: VccSettings;
    try {
      settings = loadSettings();
    } catch {
      return;
    }
    // Only the method order is known here, and it holds shake.
    checkOmpSettings({ methodOrder: ["shake"] }, settings, ctx);
  });
};

/** Tests: show the notice again. */
export const resetOmpSettingsNotice = (): void => {
  noticeShown = false;
};
