import { dirname, join } from "path";
import { core, CoreUnavailable } from "./lisp-core";

const SETTINGS_FILE = "omp-vcc-config.json";
/** The file pi-vcc read on omp before the rename; the core copies it to SETTINGS_FILE once (lisp/src/settings.lisp). */
const LEGACY_SETTINGS_FILE = "pi-vcc-config.json";

export interface VccSettings {
  /**
   * When true (default), omp-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - automatic ones (threshold, overflow, idle, incomplete)
   *   - /omp-vcc (always handled regardless)
   *
   * When false, omp-vcc only handles /omp-vcc (/pi-vcc on Pi); everything else
   * falls back to the host's own LLM-based compaction. Existing config files keep their stored
   * value; the default applies to fresh installs only.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), omp-vcc boosts the default keep-tail when the current
   * keep:1 tail is small enough: if the estimated tail for keep:1 is at most
   * the budgets' minTailTokens (5k on a ~128K window), increase keep up to the
   * largest N whose tail stays within maxTailTokens (25k there). Explicit
   * `keep:N` from the user is always respected and never adjusted.
   */
  smartKeepTail: boolean;
  /** Write each compaction's decisions to omp-vcc-debug.json beside the config. */
  debug: boolean;
  /**
   * Providers for which omp-vcc defers compaction entirely (issue #27), e.g.
   * providers whose own remote compaction should run instead. Matched
   * case-insensitively against ctx.model.provider (the host's provider id — check
   * /model). Explicit /omp-vcc bypasses the skip. Unknown/undefined model never
   * skips.
   */
  skipForProviders: string[];
  /**
   * customType values whose custom_message entries are excluded from the
   * summarizer input. Opt-in (default []). Intended for per-turn boilerplate
   * injected by other extensions that is regenerated every turn.
   * Exact match on customType. The cut still keeps and counts them; only when
   * what a cut would summarize is nothing but skipped messages does it
   * summarize the whole window instead, since that summary would be empty.
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
   * When true (default), keep the original of every message omp may rewrite in
   * the session file (tool output it blanks or shakes into artifact:// files,
   * long text blocks it shakes) in `<session>.jsonl.vcc-raw`, so vcc_recall
   * reads what was there (hooks/raw-capture.ts, lisp/src/raw-capture.lisp).
   */
  keepOriginals: boolean;
  /**
   * When true (default), each compaction brings back in a [Working Set]
   * section what the next step likely needs, from the originals: the latest
   * version of the files the work is on, the latest unresolved failure, the
   * results most relevant to the latest request (lisp/src/working-set.lisp), within
   * a share of the window.
   */
  workingSet: boolean;
  /**
   * When true, old turns leave the context whole instead of being summarized
   * (lisp/src/evict.lisp): the agent takes them out with vcc_context, the user
   * with /omp-vcc-evict, and past 85% of the host's trigger the oldest finished
   * turns leave by themselves, down to half of it. Nothing is rewritten: the
   * session file keeps every word and vcc_recall expand reads it back. Off by
   * default; the summary stays the safety net either way.
   */
  evict: boolean;
}

/** omp-vcc's config for one binding: its file in the host's agent directory (or OMP_VCC_CONFIG_PATH). */
export interface Config {
  /** Resolved at every call: the env override can change between loads. */
  path(): string;
  /** The settings as the file says now: a user may edit it mid-session, and it is a few hundred bytes. */
  load(): VccSettings;
  /**
   * Ensure the file exists with every default key:
   * - missing: copy the pre-rename pi-vcc-config.json from the same directory
   *   when there is one, else write the defaults;
   * - not valid JSON: left alone, never clobbered;
   * - valid: missing keys added, existing values kept.
   */
  scaffold(): void;
  /** Where omp-vcc keeps what it learns next to the config (omp-vcc-models.json, lisp/src/limits.lisp). */
  dir(): string;
}

export const openConfig = (agentDir: () => string): Config => {
  const path = () => process.env.OMP_VCC_CONFIG_PATH ?? join(agentDir(), SETTINGS_FILE);
  let scaffoldPending = false;
  const config: Config = {
    path,
    dir: () => dirname(path()),
    load: () => {
      // A scaffold the core could not do yet (it was being built when omp-vcc loaded) is done now.
      if (scaffoldPending) config.scaffold();
      return core({ op: "settings", path: path() }).settings as VccSettings;
    },
    scaffold() {
      // Copying pi-vcc's file is for the agent directory only: a path the user named is theirs as it is.
      const legacy = process.env.OMP_VCC_CONFIG_PATH == null ? join(dirname(path()), LEGACY_SETTINGS_FILE) : null;
      scaffoldPending = false;
      try {
        core({ op: "settings", path: path(), legacy, scaffold: true });
      } catch (err) {
        // The core leaves a file it cannot write as it is; while the core is not there, the next load does it.
        // A core that fails throws, as everywhere.
        if (!(err instanceof CoreUnavailable)) throw err;
        scaffoldPending = true;
      }
    },
  };
  return config;
};
