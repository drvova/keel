// A config file of a test file's own: KEEL_CONFIG_PATH points at it from the
// first test of the file (or describe) on, and is put back after the last.
import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface TempConfig {
  /** The directory the config is in: keel keeps what it learns (keel-models.json) beside it. */
  dir: string;
  path: string;
  /** Write SETTINGS as the whole config. */
  write(settings: Record<string, unknown>): void;
}

export const tempConfig = (prefix: string, settings?: Record<string, unknown>): TempConfig => {
  const config: TempConfig = { dir: "", path: "", write: (s) => writeFileSync(config.path, JSON.stringify(s)) };
  const prev = process.env.KEEL_CONFIG_PATH;
  beforeAll(() => {
    config.dir = mkdtempSync(join(tmpdir(), prefix));
    config.path = join(config.dir, "keel-config.json");
    process.env.KEEL_CONFIG_PATH = config.path;
    if (settings) config.write(settings);
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.KEEL_CONFIG_PATH;
    else process.env.KEEL_CONFIG_PATH = prev;
    rmSync(config.dir, { recursive: true, force: true });
  });
  return config;
};
