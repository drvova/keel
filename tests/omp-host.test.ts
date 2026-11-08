// keel inside a real omp (oh-my-pi) session: loaded from this package's
// "omp.extensions" by omp's own loader, driven through omp's command routing,
// compaction pipeline and tool validator. No model is called: keel's summary is
// local, and omp only needs a catalog model to build the session.
//
// Runs only where @oh-my-pi/pi-coding-agent is installed (it needs Bun >= 1.4.4):
//   V=18.14.2; npm install --no-save --ignore-scripts --no-audit --no-fund @oh-my-pi/pi-coding-agent@$V
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { removeDir } from "./support/session-files";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ompInstalled = (() => {
  try {
    Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir);
    return true;
  } catch {
    return false;
  }
})();

const REPO = resolve(import.meta.dir, "..");

describe.skipIf(!ompInstalled)("omp host", () => {
  let work: string;
  const savedEnv: Record<string, string | undefined> = {};
  let session: any;
  let sessionManager: any;
  let extensionsResult: any;
  const notices: string[] = [];
  let model: any;
  let omp: any;

  const now = () => Date.now();
  const user = (text: string) => sessionManager.appendMessage({ role: "user", content: text, timestamp: now() });
  const assistant = (content: any[]) =>
    sessionManager.appendMessage({
      role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
  const toolResult = (id: string, name: string, text: string) =>
    sessionManager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: now() });
  const latestCompaction = () => [...sessionManager.getBranch()].reverse().find((e: any) => e.type === "compaction");

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "keel-omp-host-"));
    for (const key of ["PI_CODING_AGENT_DIR", "KEEL_CONFIG_PATH", "ANTHROPIC_API_KEY"]) savedEnv[key] = process.env[key];
    process.env.PI_CODING_AGENT_DIR = join(work, "agent");
    process.env.KEEL_CONFIG_PATH = join(work, "keel-config.json");
    // These follow the summary: with eviction on (the default) automatic passes wait while old turns can leave.
    writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ evict: false }));
    // omp runs an automatic pass only through a method its model can use, which
    // needs a credential for the model's provider. Nothing is sent with it: the
    // compaction is keel's. Without it, CI (no key at all) skipped the idle pass.
    process.env.ANTHROPIC_API_KEY ??= "keel-test-not-a-key";

    omp = await import("@oh-my-pi/pi-coding-agent");
    const { getBundledModels }: any = await import("@oh-my-pi/pi-catalog/models" as string);
    const { initializeExtensions }: any = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init" as string);
    model = getBundledModels("anthropic")[0];

    sessionManager = omp.SessionManager.create(work, join(work, "sessions"));
    const created = await omp.createAgentSession({
      cwd: work,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionManager,
      // Let a short test session compact: omp keeps this much verbatim before any hook runs.
      // A threshold of the user's own: omp hands it to the hook, which sizes for it.
      settings: omp.Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.thresholdPercent": 60 }),
      model,
      additionalExtensionPaths: [REPO],
      disableExtensionDiscovery: true,
      enableMCP: false,
      enableLsp: false,
      hasUI: false,
    });
    session = created.session;
    extensionsResult = created.extensionsResult;
    // Wire command actions (ctx.compact) the way omp's RPC mode does.
    const uiContext = new Proxy({}, {
      get: (_t, key) => (key === "notify" ? (m: string, t?: string) => notices.push(`${t}: ${m}`) : () => undefined),
    });
    await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, mode: "rpc", uiContext });

    user("Fix the auth bug, users cannot log in after password reset");
    assistant([{ type: "text", text: "Looking at the session code." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/auth/session.ts:1-80" } }]);
    toolResult("c1", "read", "export function refresh() {}\n".repeat(50));
    assistant([{ type: "toolCall", id: "c2", name: "edit", arguments: { input: "[src/auth/session.ts#1A2B]\nPUT 4.=4:\n+refreshToken();" } }]);
    toolResult("c2", "edit", "[src/auth/session.ts#3C4D]\nok");
    sessionManager.appendMessage({ role: "pythonExecution", code: "print(1+1)", output: "2", exitCode: 0, cancelled: false, truncated: false, timestamp: now() });
    user("Also update the token refresh logic");
    assistant([{ type: "text", text: "Done, the refresh now runs after reset." }]);
    user("Now run the tests");
    assistant([{ type: "text", text: "Tests pass." }]);
  }, 60_000);

  afterAll(async () => {
    await session?.dispose?.();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeDir(work);
  });

  test("omp loads the omp.extensions entry and registers keel_recall as a top-level read tool", () => {
    expect(extensionsResult.errors ?? []).toEqual([]);
    expect(extensionsResult.extensions.map((e: any) => e.path)).toContain(join(REPO, "index.ts"));
    expect(session.getActiveToolNames()).toContain("keel_recall");
    const tool = session.getToolByName("keel_recall");
    expect(tool.loadMode).toBe("essential");
    expect(tool.approval).toBe("read");
  });

  test("/keel keep:1 compacts with keel through omp's command routing", async () => {
    await session.prompt("/keel keep:1");
    const compaction = latestCompaction();
    expect(compaction.fromExtension).toBe(true);
    expect(compaction.details).toMatchObject({ compactor: "keel", reason: "manual", willRetry: false });
    // omp's own trigger for this model under that setting, not keel's guess of omp's default.
    expect(compaction.details.limits).toMatchObject({ contextWindow: model.contextWindow, trigger: Math.floor(model.contextWindow * 0.6) });
    expect(compaction.summary).toContain("- Modified: src/auth/session.ts");
    expect(compaction.summary).toContain("- Read: src/auth/session.ts\n");
    expect(compaction.summary).toMatch(/>>> print\(1\+1\) \(#\d+\)/);
    await Bun.sleep(600);
    expect(notices.some((n) => n.startsWith("info: keel: kept 1/3 turns"))).toBe(true);
  });

  test("omp's validator accepts what keel repairs, and keel_recall resolves #N refs", async () => {
    const { validateToolArguments }: any = await import("@oh-my-pi/pi-ai/utils/validation" as string);
    const tool = session.getToolByName("keel_recall");
    for (const args of [{ expand: "#3" }, { range: "0-2" }, { range: [5] }, { page: "2" }, { mode: "all" }, { scope: "ALL" }]) {
      expect(validateToolArguments(tool, { type: "toolCall", id: "v", name: "keel_recall", arguments: args })).toEqual(args);
    }
    const result = await tool.execute("t", { expand: "#3" }, undefined, undefined);
    expect(result.content[0].text).toContain("Expanded #3:");
    const touched = await tool.execute("t", { mode: "touched" }, undefined, undefined);
    expect(touched.content[0].text).toContain("src/auth/session.ts    #3 (edit)");
  });

  test("after /clear, an automatic pass summarizes only what follows it", async () => {
    sessionManager.appendResetBoundary();
    user("After clear: move the billing cron to the new queue");
    assistant([{ type: "toolCall", id: "c9", name: "bash", arguments: { command: 'git commit -m "chore: move billing cron"' } }]);
    toolResult("c9", "bash", "[main abc1234] chore: move billing cron");
    user("Next: add a retry");
    assistant([{ type: "text", text: "Retry added." }]);

    const before = latestCompaction();
    await session.runIdleCompaction();
    const compaction = latestCompaction();
    expect(compaction.id).not.toBe(before.id);
    expect(compaction.details).toMatchObject({ compactor: "keel", reason: "idle", willRetry: false, previousSummaryUsed: false });
    expect(compaction.summary).toContain("- abc1234: chore: move billing cron");
    expect(compaction.summary).not.toContain("password reset");
  });

  test("a keel_pin note is stored by omp and leads the next summary", async () => {
    const pin = session.getToolByName("keel_pin");
    expect(pin.approval).toBe("read");
    const result = await pin.execute("p", { note: "Never edit anything under migrations/." }, undefined, undefined);
    expect(result.content[0].text).toMatch(/^Pinned \[1\] Never edit anything under migrations\/\. \(agent, #\d+\)\.$/);
    expect(sessionManager.getBranch().some((e: any) => e.type === "custom" && e.customType === "keel.pin")).toBe(true);
    user("Then add a dry-run flag");
    assistant([{ type: "text", text: "Dry-run flag added." }]);
    user("And document it");
    assistant([{ type: "text", text: "Documented." }]);
    await session.prompt("/keel keep:1");
    expect(latestCompaction().summary.startsWith("[Pinned Notes]\n- [1] Never edit anything under migrations/. (agent")).toBe(true);
  });

  test("keel_recall lists and searches the project's other omp sessions", async () => {
    const other = omp.SessionManager.create(work, join(work, "sessions"));
    other.appendMessage({ role: "user", content: "Rotate the staging API key", timestamp: now() });
    other.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Rotated it; the old key is revoked in vault path secret/staging/api." }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    await other.flush?.();
    const short = other.getSessionId().replace(/-/g, "").slice(0, 8);
    const recall = session.getToolByName("keel_recall");
    const listed = (await recall.execute("s", { mode: "sessions" }, undefined, undefined)).content[0].text;
    expect(listed).toContain(`${short} · `);
    expect(listed).toContain('"Rotate the staging API key"');
    const found = (await recall.execute("q", { query: "vault staging key revoked", scope: "project" }, undefined, undefined)).content[0].text;
    expect(found).toContain(`[session ${short}] #1 [assistant]`);
    await other.close?.();
  });

  test("what omp blanks in the session file, keel_recall still reads, with nothing set in omp", async () => {
    // omp tells extensions of a finished turn; keel copies what omp may rewrite from omp's own entries.
    await session.extensionRunner.emit({ type: "turn_end", turnIndex: 0, message: undefined, toolResults: [] });
    const file = sessionManager.getSessionFile();
    expect(existsSync(`${file}.keel-raw`)).toBe(true);
    // As omp's prune does: blank the first read's output in place and persist the rewrite.
    const entries = sessionManager.getEntries().filter((e: any) => e.type === "message");
    const read = entries.find((e: any) => e.message.role === "toolResult" && e.message.toolCallId === "c1");
    read.message.content = [{ type: "text", text: "[Output truncated - 400 tokens]" }];
    read.message.prunedAt = Date.now();
    await sessionManager.rewriteEntries();
    expect(readFileSync(file, "utf8")).not.toContain("export function refresh() {}");
    const recall = session.getToolByName("keel_recall");
    const index = entries.indexOf(read);
    const expanded = (await recall.execute("x", { expand: [index] }, undefined, undefined)).content[0].text;
    expect(expanded).toContain("export function refresh() {}");
    expect(expanded).not.toContain("[Output truncated");
    // Before the next request omp hands extensions the messages: its placeholder now says where the original is.
    const [pointed] = await session.extensionRunner.emitContext([structuredClone(read.message)]);
    expect(pointed.content).toEqual([{ type: "text", text: `[Output truncated - 400 tokens] (the original: keel_recall expand:[${index}])` }]);
  });

  test("/keel-evict takes old turns out of the next request whole, and keel_recall still reads them", async () => {
    user("Write the release notes for 2.0");
    assistant([{ type: "text", text: "Done." }]);
    user("Tag the release");
    assistant([{ type: "text", text: "Done." }]);
    const config = process.env.KEEL_CONFIG_PATH!;
    const saved = readFileSync(config, "utf8");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(saved), evict: true }));
    try {
      notices.length = 0;
      await session.prompt("/keel-evict 1");
      expect(notices.join("\n")).toContain("Out of context from the next request: #");
      // The request the host builds next, through its own context hook.
      const messages = sessionManager.buildSessionContext().messages;
      const sent = await session.extensionRunner.emitContext(structuredClone(messages));
      const text = (m: any) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("") : "");
      const stub = sent.find((m: any) => text(m).includes("out of context:"));
      expect(text(stub)).toMatch(/^\[#(\d+)–#\d+ out of context: 1 turn, by the user\./);
      expect(sent.length).toBeLessThan(messages.length + 1);
      expect(sent.some((m: any) => text(m) === "Tag the release")).toBe(true);
      // What left the request is in the session, word for word.
      const n = Number(text(stub).match(/^\[#(\d+)/)![1]);
      const recall = session.getToolByName("keel_recall");
      const expanded = (await recall.execute("x", { expand: [n] }, undefined, undefined)).content[0].text;
      expect(expanded).toContain(`Expanded #${n}:`);
    } finally {
      writeFileSync(config, saved);
    }
  });

});
