// keel's config file for one binding: where it is. The core reads it, fills in
// missing keys and copies an earlier name's file (lisp/src/settings.lisp, where
// each setting is described with its default).
import { existsSync } from "fs";
import { dirname, join } from "path";
import { core, CoreUnavailable, env } from "./core";

const SETTINGS_FILE = "keel-config.json";
/** The files keel read under its earlier names, omp-vcc and pi-vcc: the first there is is copied to SETTINGS_FILE once. */
const LEGACY_SETTINGS_FILES = ["omp-vcc-config.json", "pi-vcc-config.json"];
/** The config path a user named, under keel's name or omp-vcc's. */
const namedPath = () => env("CONFIG_PATH");

/** The settings the binding itself reads; the core reads the rest. */
export interface KeelSettings {
  keepOriginals: boolean;
  evict: boolean;
  [key: string]: unknown;
}

export interface Config {
  /** keel-config.json in the host's agent directory, or the path KEEL_CONFIG_PATH names; read at every call, as the env can change. */
  path(): string;
  /** The settings as the file says now: a user may edit it mid-session, and it is a few hundred bytes. */
  load(): KeelSettings;
  /** The file made whole: written with the defaults (or an earlier name's copied) when missing, missing keys added, a file that is not JSON left alone. */
  scaffold(): void;
}

export const openConfig = (agentDir: () => string): Config => {
  const path = () => namedPath() ?? join(agentDir(), SETTINGS_FILE);
  let scaffoldPending = false;
  const config: Config = {
    path,
    load: () => {
      // A scaffold the core could not do yet (it was being built when keel loaded) is done now.
      if (scaffoldPending) config.scaffold();
      return core({ op: "settings", path: path() }).settings as KeelSettings;
    },
    scaffold() {
      // Copying an earlier name's file is for the agent directory only: a path the user named is theirs as it is.
      const legacy = namedPath() == null ? LEGACY_SETTINGS_FILES.map((f) => join(dirname(path()), f)).find((f) => existsSync(f)) ?? null : null;
      scaffoldPending = false;
      try {
        core({ op: "settings", path: path(), legacy, scaffold: true });
      } catch (err) {
        // While the core is not there, the next load does it; a core that fails throws, as everywhere.
        if (!(err instanceof CoreUnavailable)) throw err;
        scaffoldPending = true;
      }
    },
  };
  return config;
};
