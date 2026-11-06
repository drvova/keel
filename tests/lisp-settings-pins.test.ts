// The Lisp core's config file and pin calls (lisp/src/settings.lisp and
// pins.lisp, ops settings and pin) against settings.ts and pins.ts: generated
// config files (every value shape, malformed text, arrays, other JSON, number
// forms JSON.parse reads its own way) loaded and scaffolded, byte for byte, with
// and without the pre-rename file; and generated vcc_pin calls and pin commands
// on generated branches, compared by what is told, appended and sent to the
// agent. Skips without SBCL.
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConfig } from "../src/core/settings";
import { executePin } from "../src/tools/pin";
import { registerPinCommands } from "../src/commands/pin";
import { OMP_HOST } from "../src/host";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), "omp-vcc-lisp-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const KEYS = ["overrideDefaultCompaction", "smartKeepTail", "debug", "skipForProviders", "skipCustomTypes", "trackCommands", "keepOriginals", "workingSet"];
const VALUES: unknown[] = [true, false, "true", " FALSE ", "True", "no", "yes", 1, 0, null, [], ["a"], ["ssh", " ssh", "", "  ", 3, "gh pr", "ssh"], {}, "ſtrue", "falſe", " true "];

/** Config files every run reads: each value under each key, and numbers written back in each of JavaScript's notations. */
const FIXED: string[] = [
  ...VALUES.map((v) => JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, v])))),
  `{"n": [1e-7, 1e-6, 0.000001234, 1e21, 1e20, 123456789.125, 9007199254740994, -1e-300, 0.1, 100, 1.5e300], "debug": "true"}`,
  `{"trackCommands": ["ssh", " ssh", "", "  ", 3, "gh pr", "ssh", "kubectl "]}`,
];

/** A config file's bytes: generated JSON objects, and text JSON.parse reads its own way. */
const configText = (r: () => number): string | Buffer => {
  const roll = r();
  if (roll < 0.6) {
    const o: Record<string, unknown> = {};
    for (const k of KEYS) if (r() < 0.5) o[k] = pick(r, VALUES);
    if (r() < 0.3) o[pick(r, ["extra", "2", "__proto__", "a\u0000b", "é"])] = pick(r, [1.5, 1e21, 2 ** 53 + 2, -0, "x", { nested: [1, { a: "b" }] }, 0.000001, 1e-7, 12345678.25]);
    return JSON.stringify(o, null, pick(r, [0, 2, 4, "\t"]));
  }
  return pick(r, [
    "", "null", "[]", "[true, {\"debug\": true}]", "\"a string\"", "42", "{", "{\"debug\": true,}", "﻿{\"debug\": true}",
    "{\"debug\": true, \"debug\": false, \"workingSet\": \"false\"}", "{\"trackCommands\": [\"ssh\"], \"n\": 01}", "{\"n\": 1.}",
    "{\"n\": 9007199254740993, \"m\": 123456789012345678901234567890, \"e\": 1E5, \"f\": -0.0}", "{\"s\": \"\\ud800 lone\", \"t\": \"\\u00e9\\n\\t\"}",
    "  {\"keepOriginals\": false}  \n", "{\"debug\": tru}", Buffer.from([0x7b, 0x22, 0x64, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
    "{\"skipForProviders\": \"anthropic\"}", "{\"n\": 1e400}".replace("1e400", "1e300"),
  ]);
};

/** Load, then scaffold, the file at `file` the way `config` does: what was read and what is on disk after. */
const runConfig = (file: string, agentDir: string, useCore: string | undefined, viaEnv: boolean) => {
  const was = process.env.OMP_VCC_CONFIG_PATH;
  if (viaEnv) process.env.OMP_VCC_CONFIG_PATH = file;
  else delete process.env.OMP_VCC_CONFIG_PATH;
  try {
    const config = openConfig(() => agentDir);
    return withCore(useCore, () => {
      const loaded = config.load();
      config.scaffold();
      return { loaded, after: existsSync(file) ? readFileSync(file).toString("base64") : null, reloaded: config.load() };
    });
  } finally {
    if (was === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
    else process.env.OMP_VCC_CONFIG_PATH = was;
  }
};

// ── pins ──

const branchOf = (r: () => number): any[] => {
  const entries: any[] = [];
  const size = Math.floor(r() * 30);
  for (let i = 0; i < size; i++) {
    const roll = r();
    if (roll < 0.4) entries.push({ type: "message", id: `m${i}`, message: { role: pick(r, ["user", "assistant"]), content: "x" } });
    else if (roll < 0.75) {
      const id = pick(r, [1, 2, 3, 4, 7, 2.0, 1.5, "3", -1, 0, 2 ** 53 + 2, 2 ** 53 + 4, undefined]);
      entries.push({ type: "custom", id: `c${i}`, customType: pick(r, ["omp-vcc.pin", "omp-vcc.pin", "other"]), data: r() < 0.08 ? pick(r, [null, "x", [1]]) : r() < 0.7
        ? { v: 1, op: "add", id, text: pick(r, ["Sessions live in SQLite", "deploy needs VPN", "  ", 5, "café 🎉 note"]), by: pick(r, ["user", "agent", "bot", undefined]), ...(r() < 0.6 ? { at: pick(r, [3, 10, 2.5, "4"]) } : {}) }
        : { v: 1, op: "remove", id } });
    } else if (roll < 0.8) entries.push({ type: "reset_boundary", id: `r${i}` });
    else if (roll < 0.9) entries.push({ type: "message", id: `n${i}`, message: null });
    else entries.push({ type: "model_change", id: `x${i}` });
  }
  return entries;
};

const NOTES = ["Sessions live in SQLite, not Redis", "  deploy\n\tneeds   the VPN  ", "", "   ", "café 🎉 note", "deploy needs VPN", `long ${"word ".repeat(80)}`, `${"x".repeat(299)}🎉 tail`, " spaced note﻿"];
const UNPINS: unknown[] = ["9007199254740995", "3", "#3", "[3]", "[#2]", 3, 2, 1, 3.5, "x", "", "  ", true, false, 0, -1, {}, [], [1], null, "#99", "1".repeat(25), 2 ** 53 + 2];

/** A tool call and what came of it: the text, the ops appended. */
const runTool = (params: unknown, branch: any[], entries: any[] | undefined, useCore: string | undefined) => {
  const appended: unknown[] = [];
  const host = { appendEntry: (type: string, data: unknown) => appended.push({ type, data }) };
  const session = { getBranch: () => branch, ...(entries ? { getEntries: () => entries } : {}) };
  const text = withCore(useCore, () => executePin(params, host, session as any));
  return { text, appended: JSON.parse(JSON.stringify(appended)) };
};

/** A pin command and what came of it: the notices, the ops appended, what the agent was sent. */
const runCommand = async (name: "pin" | "unpin", args: string, branch: any[], useCore: string | undefined) => {
  const appended: unknown[] = [];
  const sent: unknown[] = [];
  const notices: unknown[] = [];
  const handlers = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const pi: any = {
    registerCommand: (n: string, c: any) => handlers.set(n, c.handler),
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    sendMessage: (m: unknown, o: unknown) => sent.push({ m, o }),
  };
  registerPinCommands(pi, OMP_HOST);
  const ctx = { hasUI: true, ui: { notify: (m: string, t?: string) => notices.push({ m, t }) }, sessionManager: { getBranch: () => branch, getEntries: () => branch } };
  await withCore(useCore, () => handlers.get(`omp-vcc-${name}`)!(args, ctx));
  return JSON.parse(JSON.stringify({ notices, appended, sent }));
};

maybe("Lisp core settings and pins", () => {
  it("loads and scaffolds generated config files as settings.ts does, byte for byte", () => {
    for (let seed = 1; seed <= 150 + FIXED.length; seed++) {
      const r = rng(seed * 7919);
      const fixed = seed > 150 ? FIXED[seed - 151] : undefined;
      const text = fixed ?? (r() < 0.15 ? undefined : configText(r));
      const legacy = !fixed && r() < 0.4 ? configText(r) : undefined;
      const viaEnv = !fixed && r() < 0.3;
      const nested = !fixed && r() < 0.2;
      const results = [undefined, core].map((useCore, k) => {
        const agent = join(dir, `s${seed}-${k}`, ...(nested ? ["deep", "er"] : []));
        if (!nested) mkdirSync(agent, { recursive: true });
        const file = join(agent, "omp-vcc-config.json");
        if (!nested && text !== undefined) writeFileSync(file, text);
        if (!nested && legacy !== undefined) writeFileSync(join(agent, "pi-vcc-config.json"), legacy);
        return runConfig(file, agent, useCore, viaEnv);
      });
      expect({ seed, ...results[1] }).toEqual({ seed, ...results[0] });
    }
  });

  it("answers generated vcc_pin calls as executePin does", () => {
    let appended = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 104729);
      const branch = branchOf(r);
      const entries = r() < 0.7 ? [...branch, ...Array.from({ length: Math.floor(r() * 5) }, (_, i) => ({ type: "message", id: `o${i}`, message: {} }))] : undefined;
      const params = pick(r, [
        undefined, null, "a string", [], {}, { note: pick(r, NOTES) }, { note: pick(r, NOTES) }, { unpin: pick(r, UNPINS) }, { unpin: pick(r, UNPINS) },
        { note: pick(r, NOTES), unpin: pick(r, UNPINS) }, { note: 5 }, { note: [], unpin: "" }, { note: pick(r, NOTES), unpin: null },
      ]);
      const ts = runTool(params, branch, entries, undefined);
      const lisp = runTool(params, branch, entries, core);
      expect({ seed, params, ...lisp }).toEqual({ seed, params, ...ts });
      appended += ts.appended.length;
    }
    expect(appended).toBeGreaterThan(40);
    // An id past 2^53, unpinned by digits JavaScript reads as the same double.
    const big = [{ type: "custom", id: "b", customType: "omp-vcc.pin", data: { v: 1, op: "add", id: 2 ** 53 + 4, text: "big", by: "user" } }];
    for (const unpin of ["9007199254740995", "9007199254740996", "9007199254740997", "[#9007199254740995]"]) {
      expect({ unpin, ...runTool({ unpin }, big, undefined, core) }).toEqual({ unpin, ...runTool({ unpin }, big, undefined, undefined) });
    }
  });

  it("answers generated pin commands as the commands do", async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 31337);
      const branch = branchOf(r);
      const name = pick(r, ["pin", "unpin"] as const);
      const args = name === "pin" ? pick(r, NOTES) : String(pick(r, UNPINS));
      const ts = await runCommand(name, args, branch, undefined);
      const lisp = await runCommand(name, args, branch, core);
      expect({ seed, name, args, ...lisp }).toEqual({ seed, name, args, ...ts });
    }
  });
});
