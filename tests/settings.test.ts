// Where the config lives on omp, and the move from pi-vcc's file name.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { DEFAULT_SETTINGS, loadSettings, scaffoldSettings, setSettingsAgentDir, settingsPath } from "../src/core/settings";

const saved = { config: process.env.OMP_VCC_CONFIG_PATH, agentDir: process.env.PI_CODING_AGENT_DIR };
let dir: string;

beforeEach(() => {
  // No entry point's agent dir: another test file in this process may have loaded one.
  setSettingsAgentDir();
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-settings-"));
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  setSettingsAgentDir();
  if (saved.config === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = saved.config;
  if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("settings", () => {
  test("without an entry point, omp's default agent dir (or PI_CODING_AGENT_DIR, which omp also reads)", () => {
    expect(settingsPath()).toBe(join(homedir(), ".omp", "agent", "omp-vcc-config.json"));
    process.env.PI_CODING_AGENT_DIR = dir;
    expect(settingsPath()).toBe(join(dir, "omp-vcc-config.json"));
  });

  test("a fresh agent dir gets the defaults, with no continue setting", () => {
    setSettingsAgentDir(() => dir);
    scaffoldSettings();
    const written = JSON.parse(readFileSync(join(dir, "omp-vcc-config.json"), "utf8"));
    expect(written).toEqual(DEFAULT_SETTINGS);
    expect("continueAfterThresholdCompact" in written).toBe(false);
  });

  test("pi-vcc's config in the same dir is carried over, its values kept and new keys filled in", () => {
    setSettingsAgentDir(() => dir);
    writeFileSync(join(dir, "pi-vcc-config.json"), JSON.stringify({ overrideDefaultCompaction: false, trackCommands: ["ssh"], continueAfterThresholdCompact: true }));
    scaffoldSettings();
    expect(existsSync(join(dir, "pi-vcc-config.json"))).toBe(true); // left in place
    const migrated = JSON.parse(readFileSync(join(dir, "omp-vcc-config.json"), "utf8"));
    expect(migrated).toMatchObject({ overrideDefaultCompaction: false, trackCommands: ["ssh"], smartKeepTail: true, skipForProviders: [] });
    expect(loadSettings()).toMatchObject({ overrideDefaultCompaction: false, trackCommands: ["ssh"] });

    // Once omp-vcc's own file exists, the old one is not read again.
    writeFileSync(join(dir, "pi-vcc-config.json"), JSON.stringify({ overrideDefaultCompaction: true }));
    scaffoldSettings();
    expect(loadSettings().overrideDefaultCompaction).toBe(false);
  });

  test("an explicit OMP_VCC_CONFIG_PATH is never filled from pi-vcc's file", () => {
    setSettingsAgentDir(() => dir);
    writeFileSync(join(dir, "pi-vcc-config.json"), JSON.stringify({ overrideDefaultCompaction: false }));
    process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
    scaffoldSettings();
    expect(loadSettings().overrideDefaultCompaction).toBe(true);
  });
});
