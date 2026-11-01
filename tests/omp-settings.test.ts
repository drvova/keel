// While omp-vcc compacts, omp's other maintenance is turned off in omp's
// runtime settings layer (src/hooks/omp-settings.ts).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyOverrides,
  exclusiveOverrides,
  loadOmpSettingLookup,
  registerOmpSettings,
  resetOmpSettingsState,
  type SettingHandle,
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
afterEach(() => resetOmpSettingsState());

/** omp's setting handles, in memory: `user` is what the user configured, `runtime` an override. */
const fakeOmp = (user: Record<string, unknown> = {}) => {
  const defaults: Record<string, unknown> = {
    "compaction.methodOrder": ["remote", "snapcompact", "handoff", "shake", "soft"],
    "compaction.experimentalContextManagement": false,
    "compaction.supersedeReads": true,
    "compaction.dropUseless": true,
  };
  const runtime: Record<string, unknown> = {};
  const handle = (id: string): SettingHandle => ({
    get: () => (id in runtime ? runtime[id] : id in user ? user[id] : defaults[id]),
    override: (_s, v) => { runtime[id] = v; },
    clearOverride: () => { delete runtime[id]; },
    isConfigured: () => id in runtime || id in user,
    provenance: () => (id in runtime ? "runtime" : id in user ? "global" : "default"),
  });
  const lookup = (id: string) => (id in defaults ? handle(id) : undefined);
  return { lookup, runtime, value: (id: string) => handle(id).get(null) };
};

describe("applyOverrides", () => {
  it("sets what differs, names what the user had configured, and releases only its own", () => {
    const omp = fakeOmp({ "compaction.supersedeReads": true, "compaction.methodOrder": ["shake", "soft"] });
    const owned = new Set<string>();
    const set = applyOverrides(omp.lookup, {}, exclusiveOverrides({ skipForProviders: [] }), owned);
    expect(set.set).toEqual(["compaction.methodOrder", "compaction.supersedeReads", "compaction.dropUseless"]);
    expect(set.replaced).toEqual([
      { id: "compaction.methodOrder", from: ["shake", "soft"] },
      { id: "compaction.supersedeReads", from: true },
    ]);
    expect(omp.value("compaction.methodOrder")).toEqual(["soft"]);
    expect(omp.value("compaction.dropUseless")).toBe(false);
    // Again: nothing left to set, and its own overrides do not read as the user's.
    expect(applyOverrides(omp.lookup, {}, exclusiveOverrides({ skipForProviders: [] }), owned)).toEqual({ set: [], replaced: [], cleared: [] });
    // Released: back to the user's values, and a runtime value omp-vcc did not set stays.
    omp.runtime["compaction.experimentalContextManagement"] = true;
    const cleared = applyOverrides(omp.lookup, {}, null, owned);
    expect(cleared.cleared).toEqual(["compaction.methodOrder", "compaction.supersedeReads", "compaction.dropUseless"]);
    expect(omp.value("compaction.methodOrder")).toEqual(["shake", "soft"]);
    expect(omp.value("compaction.experimentalContextManagement")).toBe(true);
  });

  it("keeps server compaction first for the providers omp-vcc defers to", () => {
    expect(exclusiveOverrides({ skipForProviders: ["openai"] })[0]).toMatchObject({ id: "compaction.methodOrder", value: ["remote", "soft"] });
  });
});

describe("registerOmpSettings", () => {
  const host = (scope: unknown) => {
    const handlers: Array<(e: unknown, c: unknown) => Promise<void>> = [];
    const notices: string[] = [];
    const pi: any = { on: (name: string, h: any) => name === "session_start" && handlers.push(h), pi: { settings: scope } };
    const start = async () => { for (const h of handlers) await h({}, { ui: { notify: (m: string) => notices.push(m) } }); };
    return { pi, notices, start };
  };

  it("turns omp's other maintenance off at session start, and says so once when it replaced the user's choice", async () => {
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true }));
    const omp = fakeOmp({ "compaction.methodOrder": ["shake", "soft"] });
    const h = host({});
    registerOmpSettings(h.pi, async () => omp.lookup);
    await h.start();
    await h.start();
    expect(omp.value("compaction.methodOrder")).toEqual(["soft"]);
    expect(omp.value("compaction.supersedeReads")).toBe(false);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("compaction.methodOrder ([shake, soft] → [soft]: every automatic compaction goes to omp-vcc)");
    expect(h.notices[0]).toContain('"exclusiveCompaction": false');
  });

  it("is quiet over omp's defaults, and releases everything when omp-vcc stops compacting", async () => {
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true }));
    const omp = fakeOmp();
    const h = host({});
    registerOmpSettings(h.pi, async () => omp.lookup);
    await h.start();
    expect(omp.value("compaction.methodOrder")).toEqual(["soft"]);
    expect(h.notices).toEqual([]);
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true, exclusiveCompaction: false }));
    await h.start();
    expect(omp.value("compaction.methodOrder")).toEqual(["remote", "snapcompact", "handoff", "shake", "soft"]);
    expect(omp.value("compaction.dropUseless")).toBe(true);
  });

  it("says which settings to change when omp offers no way to set them, and does nothing without omp's settings", async () => {
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true }));
    const h = host({});
    registerOmpSettings(h.pi, async () => undefined);
    await h.start();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('compaction.methodOrder: ["soft"]');
    const none = host(undefined);
    let asked = false;
    registerOmpSettings(none.pi, async () => ((asked = true), undefined));
    await none.start();
    expect(asked).toBe(false);
    expect(none.notices).toEqual([]);
  });
});

describe("omp's own setting handles", () => {
  it("accept the overrides over a user's config, never write it, and give it back when released", async () => {
    const omp: any = await import("@oh-my-pi/pi-coding-agent");
    const lookup = await loadOmpSettingLookup();
    expect(lookup).toBeDefined();
    // omp's own config file, as a user writes it.
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const config = "compaction:\n  supersedeReads: true\n  methodOrder: [shake, soft]\n";
    writeFileSync(join(agentDir, "config.yml"), config);
    const scope = await omp.Settings.loadIsolated({ cwd: agentDir, agentDir });
    const owned = new Set<string>();
    const outcome = applyOverrides(lookup!, scope, exclusiveOverrides({ skipForProviders: [] }), owned);
    expect(outcome.set).toEqual(["compaction.methodOrder", "compaction.supersedeReads", "compaction.dropUseless"]);
    expect(outcome.replaced).toEqual([
      { id: "compaction.methodOrder", from: ["shake", "soft"] },
      { id: "compaction.supersedeReads", from: true },
    ]);
    expect(lookup!("compaction.methodOrder")!.get(scope)).toEqual(["soft"]);
    expect(lookup!("compaction.methodOrder")!.provenance!(scope)).toBe("runtime");
    await scope.flush?.();
    expect(readFileSync(join(agentDir, "config.yml"), "utf8")).toBe(config);
    applyOverrides(lookup!, scope, null, owned);
    expect(lookup!("compaction.methodOrder")!.get(scope)).toEqual(["shake", "soft"]);
    expect(lookup!("compaction.supersedeReads")!.get(scope)).toBe(true);
    expect(lookup!("compaction.dropUseless")!.get(scope)).toBe(true);
  });
});
