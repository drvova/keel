// Where the config lives on omp, and the move from pi-vcc's file name.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_SETTINGS, openConfig } from "../src/core/settings";

const saved = { config: process.env.OMP_VCC_CONFIG_PATH, agentDir: process.env.PI_CODING_AGENT_DIR };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-settings-"));
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (saved.config === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = saved.config;
  if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("settings", () => {
  test("the config is in the host's agent dir, or at OMP_VCC_CONFIG_PATH", () => {
    expect(openConfig(() => dir).path()).toBe(join(dir, "omp-vcc-config.json"));
    process.env.OMP_VCC_CONFIG_PATH = "/tmp/elsewhere.json";
    expect(openConfig(() => dir).path()).toBe("/tmp/elsewhere.json");
  });

  test("a fresh agent dir gets the defaults, with no continue setting", () => {
    openConfig(() => dir).scaffold();
    const written = JSON.parse(readFileSync(join(dir, "omp-vcc-config.json"), "utf8"));
    expect(written).toEqual(DEFAULT_SETTINGS);
    expect("continueAfterThresholdCompact" in written).toBe(false);
  });

  test("pi-vcc's config in the same dir is carried over, its values kept and new keys filled in", () => {
    const config = openConfig(() => dir);
    writeFileSync(join(dir, "pi-vcc-config.json"), JSON.stringify({ overrideDefaultCompaction: false, trackCommands: ["ssh"], continueAfterThresholdCompact: true }));
    config.scaffold();
    expect(existsSync(join(dir, "pi-vcc-config.json"))).toBe(true); // left in place
    const migrated = JSON.parse(readFileSync(join(dir, "omp-vcc-config.json"), "utf8"));
    expect(migrated).toMatchObject({ overrideDefaultCompaction: false, trackCommands: ["ssh"], smartKeepTail: true, skipForProviders: [] });
    expect(config.load()).toMatchObject({ overrideDefaultCompaction: false, trackCommands: ["ssh"] });

    // Once omp-vcc's own file exists, the old one is not read again.
    writeFileSync(join(dir, "pi-vcc-config.json"), JSON.stringify({ overrideDefaultCompaction: true }));
    config.scaffold();
    expect(config.load().overrideDefaultCompaction).toBe(false);
  });

  test("an explicit OMP_VCC_CONFIG_PATH is never filled from pi-vcc's file", () => {
    const config = openConfig(() => dir);
    writeFileSync(join(dir, "pi-vcc-config.json"), JSON.stringify({ overrideDefaultCompaction: false }));
    process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
    config.scaffold();
    expect(config.load().overrideDefaultCompaction).toBe(true);
  });
});
