// omp's settings that work around omp-vcc, read from what omp hands every
// compaction and named once (src/hooks/omp-settings.ts). omp-vcc never
// changes them itself.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_SETTINGS, type VccSettings } from "../src/core/settings";
import {
  checkOmpSettings,
  ompSettingsAdvice,
  ompSettingsNotice,
  registerOmpSettingsCheck,
  resetOmpSettingsNotice,
} from "../src/hooks/omp-settings";

let dir: string;
const prev = process.env.OMP_VCC_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-omp-settings-"));
  process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
});
afterAll(() => {
  if (prev === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => resetOmpSettingsNotice());

/** omp's defaults as preparation.settings carries them (with the engine fields omp adds). */
const ompDefaults = {
  enabled: true,
  strategy: "context-full",
  remoteEnabled: false,
  methodOrder: ["remote", "snapcompact", "handoff", "shake", "soft"],
  experimentalContextManagement: false,
  supersedeReads: true,
  dropUseless: true,
  keepRecentTokens: 20_000,
};
const vcc = (over: Partial<VccSettings> = {}): VccSettings => ({ ...DEFAULT_SETTINGS, ...over });

describe("ompSettingsAdvice", () => {
  it("names what works around omp-vcc in omp's defaults, and nothing in the recommended ones", () => {
    expect(ompSettingsAdvice(ompDefaults, vcc()).map((a) => [a.id, a.current])).toEqual([
      ["compaction.methodOrder", ["remote", "snapcompact", "handoff", "shake", "soft"]],
      ["compaction.supersedeReads", true],
      ["compaction.dropUseless", true],
    ]);
    const recommended = { ...ompDefaults, methodOrder: ["soft"], supersedeReads: false, dropUseless: false };
    expect(ompSettingsAdvice(recommended, vcc())).toEqual([]);
    // Notes-backed windows on: named too.
    expect(ompSettingsAdvice({ ...recommended, experimentalContextManagement: true }, vcc()).map((a) => a.id)).toEqual(["compaction.experimentalContextManagement"]);
  });

  it("leaves server compaction to the providers omp-vcc defers to, and judges only what omp sent", () => {
    const withRemote = { methodOrder: ["remote", "soft"] };
    expect(ompSettingsAdvice(withRemote, vcc({ skipForProviders: ["openai"] }))).toEqual([]);
    expect(ompSettingsAdvice(withRemote, vcc())[0]).toMatchObject({ id: "compaction.methodOrder", recommended: ["soft"] });
    // An omp that sends none of these keys, or no settings at all.
    expect(ompSettingsAdvice({ enabled: true, keepRecentTokens: 1 }, vcc())).toEqual([]);
    expect(ompSettingsAdvice(undefined, vcc())).toEqual([]);
  });

  it("says what each does and gives the omp config set lines that change it", () => {
    const notice = ompSettingsNotice(ompSettingsAdvice(ompDefaults, vcc()));
    expect(notice).toContain("compaction.methodOrder runs shake before omp-vcc on an overflow");
    expect(notice).toContain(`omp config set compaction.methodOrder '["soft"]' and omp config set compaction.supersedeReads false and omp config set compaction.dropUseless false`);
    expect(notice).toContain('"checkOmpSettings": false');
  });
});

describe("checkOmpSettings", () => {
  const ctx = () => {
    const notices: Array<{ msg: string; level: string }> = [];
    return { notices, ui: { notify: (msg: string, level: string) => notices.push({ msg, level }) } };
  };

  it("warns once per process, and not when omp-vcc does not compact or the check is off", () => {
    const off = ctx();
    checkOmpSettings(ompDefaults, vcc({ overrideDefaultCompaction: false }), off);
    checkOmpSettings(ompDefaults, vcc({ checkOmpSettings: false }), off);
    expect(off.notices).toEqual([]);
    const on = ctx();
    checkOmpSettings(ompDefaults, vcc(), on);
    checkOmpSettings(ompDefaults, vcc(), on);
    expect(on.notices).toHaveLength(1);
    expect(on.notices[0].level).toBe("warning");
  });

  it("an automatic shake is named as it starts, other actions are not", () => {
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true }));
    const handlers: Array<(e: unknown, c: unknown) => void> = [];
    registerOmpSettingsCheck({ on: (name: string, h: any) => name === "auto_compaction_start" && handlers.push(h) } as any);
    const c = ctx();
    for (const action of ["context-full", "remote", "handoff"]) handlers[0]({ type: "auto_compaction_start", reason: "threshold", action }, c);
    expect(c.notices).toEqual([]);
    handlers[0]({ type: "auto_compaction_start", reason: "overflow", action: "shake" }, c);
    expect(c.notices).toHaveLength(1);
    expect(c.notices[0].msg).toContain(`omp config set compaction.methodOrder '["soft"]'`);
  });
});
