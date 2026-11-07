// Where the config lives on omp, the move from pi-vcc's file name, and what it reads.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openConfig } from "../src/core/settings";

/** What a fresh config holds, in its order. */
const DEFAULT_SETTINGS = {
  overrideDefaultCompaction: true, smartKeepTail: true, debug: false, skipForProviders: [], skipCustomTypes: [], trackCommands: [], keepOriginals: true, workingSet: true, evict: false,
};

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

  test("omp-vcc takes over the host's compaction, and tracks no commands, by default", () => {
    expect(DEFAULT_SETTINGS.overrideDefaultCompaction).toBe(true);
    expect(DEFAULT_SETTINGS.trackCommands).toEqual([]);
  });

  test("malformed trackCommands values coerce fail-closed to string[]", () => {
    const config = openConfig(() => dir);
    const write = (trackCommands: unknown) => writeFileSync(join(dir, "omp-vcc-config.json"), JSON.stringify({ trackCommands }));
    for (const bad of ["ssh", 42, [1, " kubectl ", null, "kubectl"], null, { 0: "ssh" }]) {
      write(bad);
      const got = config.load().trackCommands;
      expect(Array.isArray(got)).toBe(true);
      for (const x of got) expect(typeof x).toBe("string");
    }
    write(["ssh", "kubectl"]);
    expect(config.load().trackCommands).toEqual(["ssh", "kubectl"]);
  });

  test("a switch is a boolean, or true/false in quotes; any other value leaves the default", () => {
    const config = openConfig(() => dir);
    const load = (settings: Record<string, unknown>) => {
      writeFileSync(join(dir, "omp-vcc-config.json"), JSON.stringify(settings));
      return config.load();
    };
    expect(load({ debug: "no", overrideDefaultCompaction: 0 })).toMatchObject({ debug: false, overrideDefaultCompaction: true });
    expect(load({ debug: "true", overrideDefaultCompaction: "FALSE", workingSet: false })).toMatchObject({ debug: true, overrideDefaultCompaction: false, workingSet: false });
  });

  test("the file is written as JSON.stringify(value, null, 2) writes it, a newline after", () => {
    openConfig(() => dir).scaffold();
    expect(readFileSync(join(dir, "omp-vcc-config.json"), "utf8")).toBe(`${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
  });

  test("missing keys are added after the user's, which keep their order, values and number notation", () => {
    const file = join(dir, "omp-vcc-config.json");
    writeFileSync(file, '{"debug": true, "z": [1e-7, 1e21, 0.1, 12345678.5, 9007199254740993], "2": "x"}');
    openConfig(() => dir).scaffold();
    const text = readFileSync(file, "utf8");
    // Array-index keys first, as JavaScript orders an object's keys; numbers as String() writes them.
    expect(text.startsWith('{\n  "2": "x",\n  "debug": true,\n  "z": [\n    1e-7,\n    1e+21,\n    0.1,\n    12345678.5,\n    9007199254740992\n  ],\n  "overrideDefaultCompaction": true,')).toBe(true);
  });

  test("a file that is not a JSON object or array is left alone, and reads as the defaults", () => {
    const file = join(dir, "omp-vcc-config.json");
    for (const text of ["{ not json", "null", "42", '"debug"', "{\"n\": 01}"]) {
      writeFileSync(file, text);
      const config = openConfig(() => dir);
      config.scaffold();
      expect({ text, after: readFileSync(file, "utf8"), settings: config.load() }).toEqual({ text, after: text, settings: DEFAULT_SETTINGS });
    }
  });

});
