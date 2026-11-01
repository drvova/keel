// While omp-vcc compacts, omp's own context maintenance must not work around it.
//
// omp walks `compaction.methodOrder` on every automatic pass. Each method but
// one asks the session_before_compact hook first and stands down when omp-vcc
// answers; `shake` runs inline before any hook (on an overflow it is the first
// usable method for a text-only model), and when omp-vcc steps aside the next
// method (snapcompact, handoff, server compaction) writes its own summary.
// `compaction.experimentalContextManagement` replaces compaction with a
// notes-backed rollover. `compaction.supersedeReads` and `compaction.dropUseless`
// blank tool results in the session file, which vcc_recall reads as the raw
// history. So while omp-vcc handles compaction, these are set in omp's runtime
// settings layer: in memory for this process, never written to omp's config,
// cleared again when omp-vcc stops handling compaction.
//
// The handles come from omp's settings registry
// (`@oh-my-pi/pi-coding-agent/config/registry`, `lookup(id)`), which omp's
// extension docs name for runtime overrides, with `pi.pi.settings` as the
// scope; omp maps the import onto its own module instance. It is the only
// package omp-vcc imports at runtime, dynamically and behind a check: an omp
// without it keeps its settings, and omp-vcc says which ones to change.
//
// Not covered, as omp has no setting for it: the age-based prune of old tool
// output (past the newest 40K tool tokens, when it frees 20K) still runs
// before each threshold check.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadSettings, type VccSettings } from "../core/settings";

/** What omp-vcc needs of one of omp's setting handles. */
export interface SettingHandle {
  get(scope: unknown): unknown;
  override(scope: unknown, value: unknown): void;
  clearOverride(scope: unknown): void;
  isConfigured(scope: unknown): boolean;
  provenance?(scope: unknown): string;
}

export type SettingLookup = (id: string) => SettingHandle | undefined;

export interface OmpOverride {
  id: string;
  value: unknown;
  /** Why omp-vcc turns it off, for the notice. */
  why: string;
}

/** What omp-vcc sets while it compacts. `remote` stays first for the providers omp-vcc defers to (skipForProviders). */
export const exclusiveOverrides = (settings: Pick<VccSettings, "skipForProviders">): OmpOverride[] => [
  {
    id: "compaction.methodOrder",
    value: settings.skipForProviders.length > 0 ? ["remote", "soft"] : ["soft"],
    why: "every automatic compaction goes to omp-vcc",
  },
  { id: "compaction.experimentalContextManagement", value: false, why: "its rollover replaces compaction" },
  { id: "compaction.supersedeReads", value: false, why: "it blanks tool results vcc_recall reads" },
  { id: "compaction.dropUseless", value: false, why: "it blanks tool results vcc_recall reads" },
];

/** The ids of every setting omp-vcc may override, so a change of settings can release them. */
const OVERRIDE_IDS = exclusiveOverrides({ skipForProviders: [] }).map((o) => o.id);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface OverrideOutcome {
  /** Overrides set now (the value differed). */
  set: string[];
  /** Of those, the ones the user had configured themselves, with their value. */
  replaced: Array<{ id: string; from: unknown }>;
  /** Overrides released because omp-vcc no longer handles compaction. */
  cleared: string[];
}

/**
 * Set (enabled) or release (disabled) omp-vcc's overrides on `scope`. `owned`
 * holds the ids omp-vcc set, so it releases only its own and never a runtime
 * value something else set.
 */
export const applyOverrides = (
  lookup: SettingLookup,
  scope: unknown,
  overrides: OmpOverride[] | null,
  owned: Set<string>,
): OverrideOutcome => {
  const outcome: OverrideOutcome = { set: [], replaced: [], cleared: [] };
  const wanted = new Map((overrides ?? []).map((o) => [o.id, o]));
  for (const id of OVERRIDE_IDS) {
    const handle = lookup(id);
    if (!handle) continue; // an omp without this setting has nothing to turn off
    const override = wanted.get(id);
    try {
      if (!override) {
        if (owned.delete(id)) {
          handle.clearOverride(scope);
          outcome.cleared.push(id);
        }
        continue;
      }
      const current = handle.get(scope);
      if (same(current, override.value)) continue;
      const configured = handle.isConfigured(scope) && handle.provenance?.(scope) !== "runtime";
      handle.override(scope, override.value);
      owned.add(id);
      outcome.set.push(id);
      if (configured) outcome.replaced.push({ id, from: current });
    } catch {}
  }
  return outcome;
};

/** omp's settings registry, or undefined when this omp has none an extension can reach. */
export const loadOmpSettingLookup = async (): Promise<SettingLookup | undefined> => {
  try {
    const registry: { lookup?: unknown } = await import("@oh-my-pi/pi-coding-agent/config/registry");
    return typeof registry.lookup === "function" ? (registry.lookup as SettingLookup) : undefined;
  } catch {
    return undefined;
  }
};

// omp's settings are one store for the process, shared by every session's
// binding (subagents read through to it), so what omp-vcc set is tracked here.
const owned = new Set<string>();
let noticeShown = false;

const describeValue = (value: unknown): string => (Array.isArray(value) ? `[${value.join(", ")}]` : String(value));

const replacedNotice = (replaced: OverrideOutcome["replaced"], overrides: OmpOverride[]): string =>
  `omp-vcc: compacting for omp in this process, so it turned off ` +
  replaced
    .map(({ id, from }) => {
      const o = overrides.find((x) => x.id === id)!;
      return `${id} (${describeValue(from)} → ${describeValue(o.value)}: ${o.why})`;
    })
    .join(", ") +
  `. Your omp config is unchanged; "exclusiveCompaction": false in omp-vcc's config keeps it as configured.`;

const unreachableNotice = (overrides: OmpOverride[]): string =>
  `omp-vcc: this omp does not let it change its settings, so omp's own maintenance still runs around omp-vcc. ` +
  `For omp-vcc to handle all of it, set ${overrides.map((o) => `${o.id}: ${JSON.stringify(o.value)}`).join(", ")} in omp's config.`;

/**
 * Bring omp's settings in line with omp-vcc's: on every session start, set the
 * overrides while omp-vcc handles compaction (overrideDefaultCompaction and
 * exclusiveCompaction), release them otherwise.
 */
export const registerOmpSettings = (pi: ExtensionAPI, lookupLoader: () => Promise<SettingLookup | undefined> = loadOmpSettingLookup): void => {
  pi.on("session_start", async (_event, ctx) => {
    let settings: VccSettings;
    try {
      settings = loadSettings();
    } catch {
      return;
    }
    let scope: unknown;
    try {
      scope = (pi as { pi?: { settings?: unknown } }).pi?.settings;
      // omp's global settings throw on access until they are initialized.
      if (scope) void (scope as { getCwd?: () => unknown }).getCwd?.();
    } catch {
      scope = undefined;
    }
    if (!scope) return; // not a host with omp's settings (tests' fake hosts)
    const overrides = settings.overrideDefaultCompaction && settings.exclusiveCompaction ? exclusiveOverrides(settings) : null;
    const lookup = await lookupLoader();
    if (!lookup) {
      if (overrides && !noticeShown) {
        noticeShown = true;
        try {
          ctx?.ui?.notify?.(unreachableNotice(overrides), "warning");
        } catch {}
      }
      return;
    }
    const outcome = applyOverrides(lookup, scope, overrides, owned);
    if (overrides && outcome.replaced.length > 0 && !noticeShown) {
      noticeShown = true;
      try {
        ctx?.ui?.notify?.(replacedNotice(outcome.replaced, overrides), "info");
      } catch {}
    }
  });
};

/** Tests: forget what was set and shown. */
export const resetOmpSettingsState = (): void => {
  owned.clear();
  noticeShown = false;
};
