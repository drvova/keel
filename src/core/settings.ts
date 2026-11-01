import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const SETTINGS_FILE = "omp-vcc-config.json";
/** The file pi-vcc read on omp before the rename; copied to SETTINGS_FILE once. */
const LEGACY_SETTINGS_FILE = "pi-vcc-config.json";

// omp's agent directory, set by the entry point from pi.pi.getAgentDir() so this
// module imports no host package.
let agentDirResolver: (() => string) | undefined;

/** Called once by the entry point with omp's getAgentDir; no argument restores the default. */
export const setSettingsAgentDir = (resolve?: () => string): void => {
  agentDirResolver = resolve;
};

/** omp's own default (~/.omp/agent, or PI_CODING_AGENT_DIR), used only if no entry point set one. */
const fallbackAgentDir = (): string => {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env === "~" ? homedir() : env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
  return join(homedir(), ".omp", "agent");
};

/** Resolved at every call: the env override and the host can change between loads. */
export const settingsPath = (): string =>
  process.env.OMP_VCC_CONFIG_PATH ?? join((agentDirResolver ?? fallbackAgentDir)(), SETTINGS_FILE);

export interface VccSettings {
  /**
   * When true (default), omp-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - automatic ones (threshold, overflow, idle, incomplete)
   *   - /omp-vcc (always handled regardless)
   *
   * When false, omp-vcc only handles /omp-vcc; everything else falls back to
   * omp's own LLM-based compaction. Existing config files keep their stored
   * value; the default applies to fresh installs only.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), omp-vcc boosts the default keep-tail when the current
   * keep:1 tail is small enough. Specifically: if the estimated tail for keep:1
   * is <= MIN_SMART_TAIL_TOKENS (5k), increase keep up to the largest N whose
   * tail stays <= MAX_SMART_TAIL_TOKENS (25k). Explicit `keep:N` from the user
   * is always respected and never adjusted.
   */
  smartKeepTail: boolean;
  /** Write debug snapshot to /tmp/omp-vcc-debug.json on each compaction. */
  debug: boolean;
  /**
   * Providers for which omp-vcc defers compaction entirely (issue #27), e.g.
   * providers whose own remote compaction should run instead. Matched
   * case-insensitively against ctx.model.provider (omp's provider id — check
   * /model). Explicit /omp-vcc bypasses the skip. Unknown/undefined model never
   * skips.
   */
  skipForProviders: string[];
  /**
   * customType values whose custom_message entries are excluded from the
   * summarizer input. Opt-in (default []). Intended for per-turn boilerplate
   * injected by other extensions that is regenerated every turn.
   * Exact match on customType. Filtering happens right before summarization:
   * cut selection, token calibration, firstKeptEntryId and kept-user-turn
   * counting are all unaffected.
   */
  skipCustomTypes: string[];
  /**
   * Commands whose bash invocations are kept in a "[Tracked Commands]" section,
   * e.g. `["ssh", "kubectl"]`, `["psql"]`, or a prefix like `"gh pr"`. Each
   * entry is the command as written up to the next unquoted separator
   * (`;`/`&`/`|`/newline) -- no per-command argument parsing. Also scans an
   * `ssh host "<remote command>"` string for the other tracked names.
   * Empty by default (feature off).
   */
  trackCommands: string[];
  /**
   * When true (default), omp-vcc asks the model's provider for its context
   * length (`${baseUrl}/models`, OpenAI-compatible APIs, once per base URL, with
   * omp's credentials for that provider) and sizes compactions by the smaller of
   * that and omp's window. false: omp's window and overflow errors only.
   */
  probeProviderWindow: boolean;
  /**
   * When true (default) and omp-vcc handles compaction, say once per process
   * which of omp's settings work around it (compaction methods other than the
   * one that asks omp-vcc, notes-backed context rollover, the blanking of tool
   * results in the session file vcc_recall reads), with the `omp config set`
   * lines that change them (hooks/omp-settings.ts). omp-vcc never changes
   * omp's settings itself.
   */
  checkOmpSettings: boolean;
}

export const DEFAULT_SETTINGS: VccSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  debug: false,
  skipForProviders: [],
  skipCustomTypes: [],
  trackCommands: [],
  probeProviderWindow: true,
  checkOmpSettings: true,
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

/** Coerce a config value to string[], failing closed to []. */
const coerceStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function loadSettings(): VccSettings {
  const parsed = readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  const merged = { ...DEFAULT_SETTINGS, ...(parsed as Partial<VccSettings>) };
  // A blind spread would leak a malformed array value (e.g. a bare string,
  // where .includes becomes substring matching) into the provider check.
  merged.skipForProviders = coerceStringArray(parsed.skipForProviders);
  merged.skipCustomTypes = coerceStringArray(parsed.skipCustomTypes);
  // Blank names would match every command; duplicates would repeat lines.
  merged.trackCommands = [
    ...new Set(coerceStringArray(parsed.trackCommands).map((s) => s.trim()).filter(Boolean)),
  ];
  return merged;
}

/**
 * Ensure the config file (omp's agent dir, or OMP_VCC_CONFIG_PATH) exists with default keys.
 * - File missing → copy the pre-rename pi-vcc-config.json from the same directory
 *   when there is one, else create with the full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export function scaffoldSettings(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      const legacy = join(dir, LEGACY_SETTINGS_FILE);
      if (process.env.OMP_VCC_CONFIG_PATH == null && existsSync(legacy)) copyFileSync(legacy, path);
      else {
        writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
        return;
      }
    }

    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort; never crash extension load
  }
}
