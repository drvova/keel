// While keel's core cannot run yet (no SBCL to build it here, or the build
// still going), every surface says why and steps aside: the compaction hook
// leaves the pass to the host and tells the user once, the tools answer with
// the reason. tests/lisp-build.test.ts covers the build itself.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHook } from "./support/host";
import { registerRecallTool } from "../src/tools/recall";
import { registerPinTool } from "../src/tools/pin";
import { ompBinding } from "./support/binding";

const saved = { core: process.env.KEEL_CORE, sbcl: process.env.SBCL, dir: process.env.KEEL_CORE_BUILD_DIR };
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-core-wait-"));
  // No core named, no build of these sources where builds go, and no SBCL to make one.
  delete process.env.KEEL_CORE;
  process.env.KEEL_CORE_BUILD_DIR = dir;
  process.env.SBCL = "/nonexistent/sbcl";
});
afterAll(() => {
  for (const [k, v] of [["KEEL_CORE", saved.core], ["SBCL", saved.sbcl], ["KEEL_CORE_BUILD_DIR", saved.dir]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const user = (id: string, content: string) => ({ type: "message", id, parentId: null, message: { role: "user", content } });

describe("while the core cannot run", () => {
  it("the hook leaves the compaction to the host and tells the user why, once", () => {
    let handler: any;
    registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    const told: string[] = [];
    const entries = [user("a", "first request"), user("b", "second request")];
    const ctx = { ui: { notify: (m: string) => told.push(m) }, sessionManager: { getEntries: () => entries, getBranch: () => entries } };
    const event = { type: "session_before_compact", branchEntries: entries, customInstructions: undefined, signal: new AbortController().signal,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 100 } };
    expect(handler(event, ctx)).toBeUndefined();
    expect(handler(event, ctx)).toBeUndefined();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("keel needs SBCL to build its core");
  });

  it("the extension still loads, every command and tool but the one the core's settings decide", () => {
    const { register } = require("../src/register") as typeof import("../src/register");
    const commands: string[] = [];
    const tools: string[] = [];
    const pi: any = { on: () => {}, registerCommand: (name: string) => commands.push(name), registerTool: (t: any) => tools.push(t.name), appendEntry: () => {} };
    const host: any = { ...require("../src/host").OMP_HOST, agentDir: () => dir, convertToLlm: (m: unknown[]) => m, triggerOf: () => ({ reason: "manual", willRetry: false }) };
    expect(() => register(pi, host)).not.toThrow();
    expect(commands).toContain("keel-evict");
    expect(tools).toEqual(expect.arrayContaining(["keel_recall", "keel_pin"]));
  });

  it("keel_recall and keel_pin answer with the reason", async () => {
    const tools: any[] = [];
    const pi: any = { registerTool: (t: any) => tools.push(t), appendEntry: () => {} };
    registerRecallTool(pi, ompBinding);
    registerPinTool(pi, ompBinding);
    const ctx = { sessionManager: { getEntries: () => [], getBranch: () => [] }, model: undefined };
    for (const t of tools) {
      const out = await t.execute("x", t.name === "keel_pin" ? { note: "keep this" } : { query: "anything" }, undefined, undefined, ctx);
      expect({ tool: t.name, text: out.content[0].text }).toEqual({ tool: t.name, text: expect.stringContaining("install SBCL") });
    }
  });
});
