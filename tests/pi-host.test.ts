// keel inside a real Pi session: loaded from this package's "pi.extensions"
// by Pi's own loader (pi.ts, with Pi's own package resolved by Pi), driven
// through Pi's command routing, compaction pipeline and tool validator. No model
// is called: keel's summary is local, and Pi only needs a catalog model to
// build the session.
//
// Runs only where @earendil-works/pi-coding-agent is installed (`bun run setup:hosts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertRealPi, piInstalled } from "./support/pi";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { PIN_ENTRY_TYPE } from "./support/names";



const REPO = resolve(import.meta.dir, "..");
const RESERVE = 20_000;

describe.skipIf(!piInstalled())("Pi host", () => {
  let work: string;
  const savedEnv: Record<string, string | undefined> = {};
  let pi: any;
  let session: any;
  let sessionManager: any;
  let extensionsResult: any;
  let modelRuntime: any;
  let model: any;
  const notices: string[] = [];

  const now = () => Date.now();
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const user = (text: string) => sessionManager.appendMessage({ role: "user", content: text, timestamp: now() });
  const assistant = (content: any[], stopReason = "toolUse") =>
    sessionManager.appendMessage({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: now(), usage });
  const toolResult = (id: string, name: string, text: string) =>
    sessionManager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: now() });
  const latestCompaction = () => [...sessionManager.getBranch()].reverse().find((e: any) => e.type === "compaction");
  /** A registered tool as Pi's agent runs it: validated arguments, the session's context. */
  const agentTool = (name: string) => session.agent.state.tools.find((t: any) => t.name === name);

  beforeAll(async () => {
    assertRealPi();
    work = mkdtempSync(join(tmpdir(), "keel-pi-host-"));
    for (const key of ["PI_CODING_AGENT_DIR", "KEEL_CONFIG_PATH"]) savedEnv[key] = process.env[key];
    process.env.PI_CODING_AGENT_DIR = join(work, "agent");
    process.env.KEEL_CONFIG_PATH = join(work, "keel-config.json");
    // These follow the summary: with eviction on (the default) automatic passes wait while old turns can leave.
    writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ evict: false }));

    pi = await import("@earendil-works/pi-coding-agent");
    modelRuntime = await pi.ModelRuntime.create({ authPath: join(work, "auth.json"), modelsPath: join(work, "models.json") });
    model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");

    const resourceLoader = new pi.DefaultResourceLoader({ cwd: work, agentDir: process.env.PI_CODING_AGENT_DIR, additionalExtensionPaths: [REPO] });
    await resourceLoader.reload();
    sessionManager = pi.SessionManager.create(work, join(work, "sessions"));
    const created = await pi.createAgentSession({
      cwd: work,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      // Let a short test session compact: Pi keeps this much verbatim before any hook runs.
      // A reserve of the user's own: Pi hands it to the hook, which sizes for it.
      settingsManager: pi.SettingsManager.inMemory({ compaction: { keepRecentTokens: 1, reserveTokens: RESERVE } }),
    });
    session = created.session;
    extensionsResult = created.extensionsResult;
    // Pi's RPC-mode bindings: a UI whose notify the test reads. A plain object:
    // Pi spreads the UI it is given, which a Proxy does not survive.
    await session.bindExtensions({
      mode: "rpc",
      uiContext: { notify: (m: string, t?: string) => notices.push(`${t}: ${m}`) },
    });

    user("Fix the auth bug, users cannot log in after password reset");
    assistant([{ type: "text", text: "Looking at the session code." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/auth/session.ts" } }]);
    toolResult("c1", "read", "export function refresh() {}\n".repeat(50));
    assistant([{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/auth/session.ts", edits: [{ oldText: "export function refresh() {}", newText: "export function refresh() { refreshToken(); }" }] } }]);
    toolResult("c2", "edit", "Successfully replaced 1 block(s) in src/auth/session.ts.");
    sessionManager.appendMessage({ role: "bashExecution", command: "bun test auth", output: "3 pass", exitCode: 0, cancelled: false, truncated: false, timestamp: now() });
    user("Also update the token refresh logic");
    assistant([{ type: "text", text: "Done, the refresh now runs after reset." }], "stop");
    user("Now run the tests");
    assistant([{ type: "text", text: "Tests pass." }], "stop");
  }, 60_000);

  afterAll(async () => {
    await session?.dispose?.();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(work, { recursive: true, force: true });
  });

  test("Pi loads the pi.extensions entry and registers the tools, the /keel commands and their /pi-vcc names", () => {
    expect(extensionsResult.errors ?? []).toEqual([]);
    expect(extensionsResult.extensions.map((e: any) => e.path)).toContain(join(REPO, "pi.ts"));
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["keel_recall", "keel_pin"]));
    const commands = session.extensionRunner.getRegisteredCommands().map((c: any) => c.name).sort();
    expect(commands).toEqual(expect.arrayContaining(["keel", "keel-pin", "keel-recall", "keel-unpin", "keel-evict", "pi-vcc", "pi-vcc-pin", "pi-vcc-recall", "pi-vcc-unpin", "pi-vcc-evict"]));
    expect(commands.some((c: string) => c.startsWith("omp-vcc"))).toBe(false);
  });

  test("/pi-vcc keep:1 compacts with keel through Pi's command routing, sized by Pi's own trigger", async () => {
    await session.prompt("/pi-vcc keep:1");
    const compaction = latestCompaction();
    expect(compaction.fromHook).toBe(true);
    expect(compaction.details).toMatchObject({ compactor: "keel", reason: "manual", willRetry: false });
    // Pi's own trigger for this model under that setting (window less reserveTokens), not omp's rule.
    expect(compaction.details.limits).toMatchObject({ contextWindow: model.contextWindow, windowSource: "pi", trigger: model.contextWindow - RESERVE });
    expect(compaction.summary).toContain("- Modified: src/auth/session.ts");
    expect(compaction.summary).toContain("- Read: src/auth/session.ts\n");
    expect(compaction.summary).toMatch(/\$ bun test auth \(#\d+\)/);
    await Bun.sleep(600);
    expect(notices.some((n) => n.startsWith("info: keel: kept 1/3 turns"))).toBe(true);
  });

  test("Pi's validator accepts keel_recall's arguments, and keel_recall resolves #N refs", async () => {
    // Pi's own copy of its validator: npm may nest pi-ai under Pi's package instead of hoisting it.
    const piDir = dirname(Bun.resolveSync("@earendil-works/pi-coding-agent/package.json", import.meta.dir));
    const { validateToolArguments }: any = await import(Bun.resolveSync("@earendil-works/pi-ai/utils/validation", piDir));
    const definition = session.getToolDefinition("keel_recall");
    for (const args of [{ expand: "#3" }, { range: "0-2" }, { range: [5] }, { mode: "all" }, { scope: "ALL" }]) {
      expect(validateToolArguments(definition, { type: "toolCall", id: "v", name: "keel_recall", arguments: args })).toEqual(args);
    }
    // Pi passes a page given as text through as it is (the schema takes either); the core reads it as a number.
    expect(validateToolArguments(definition, { type: "toolCall", id: "v", name: "keel_recall", arguments: { page: "2" } }).page).toBe("2");
    const tool = agentTool("keel_recall");
    const result = await tool.execute("t", { expand: "#3" }, undefined, undefined);
    expect(result.content[0].text).toContain("Expanded #3:");
    const touched = await tool.execute("t", { mode: "touched" }, undefined, undefined);
    expect(touched.content[0].text).toContain("src/auth/session.ts    #3 (edit)");
  });

  test("the automatic passes Pi starts itself carry their trigger to the hook", async () => {
    user("Rename the billing cron job");
    assistant([{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "git commit -m 'chore: move billing cron'" } }]);
    toolResult("b1", "bash", "[main abc1234] chore: move billing cron");
    user("And document it");
    assistant([{ type: "text", text: "Documented." }], "stop");
    const before = latestCompaction();
    // Pi's automatic paths (what its threshold check and overflow recovery run), with no model turn in a test.
    await session._runAutoCompaction("threshold", false);
    const threshold = latestCompaction();
    expect(threshold.id).not.toBe(before.id);
    expect(threshold.details).toMatchObject({ compactor: "keel", reason: "threshold", willRetry: false, previousSummaryUsed: true });
    expect(threshold.details.limits).toMatchObject({ windowSource: "pi", trigger: model.contextWindow - RESERVE });
    user("Ship it");
    assistant([{ type: "text", text: "Shipped." }], "stop");
    await session._runAutoCompaction("overflow", true);
    const overflow = latestCompaction();
    expect(overflow.id).not.toBe(threshold.id);
    expect(overflow.details).toMatchObject({ compactor: "keel", reason: "overflow", willRetry: true });
  });

  test("what Pi's context edits omit or replace, the summary leaves out", async () => {
    user("Try the migration");
    const failed = assistant([{ type: "text", text: "First attempt: dropping the users table entirely." }], "stop");
    assistant([{ type: "toolCall", id: "k1", name: "bash", arguments: { command: "cat .env" } }]);
    const secret = toolResult("k1", "bash", "API_KEY=sk-live-do-not-keep");
    // As Pi does for a retried attempt, and as an extension does to redact a result.
    sessionManager.appendContextEdit(failed, null);
    sessionManager.appendContextEdit(secret, { content: "[redacted]" });
    user("Run it again, carefully");
    assistant([{ type: "text", text: "Migrated with a backup first." }], "stop");
    user("Add a changelog entry");
    assistant([{ type: "text", text: "Added." }], "stop");
    await session.prompt("/keel keep:1");
    const summary = latestCompaction().summary;
    expect(summary).toContain("Try the migration");
    expect(summary).toContain("Migrated with a backup first.");
    expect(summary).not.toContain("dropping the users table");
    expect(summary).not.toContain("sk-live-do-not-keep");
  });

  test("a keel_pin note is stored by Pi and leads the next summary", async () => {
    const result = await agentTool("keel_pin").execute("p", { note: "Never edit anything under migrations/." }, undefined, undefined);
    expect(result.content[0].text).toMatch(/^Pinned \[1\] Never edit anything under migrations\/\. \(agent, #\d+\)\.$/);
    expect(sessionManager.getBranch().some((e: any) => e.type === "custom" && e.customType === PIN_ENTRY_TYPE)).toBe(true);
    user("Add an index to orders");
    assistant([{ type: "text", text: "Added." }], "stop");
    await session.prompt("/keel");
    expect(latestCompaction().summary.startsWith("[Pinned Notes]\n- [1] Never edit anything under migrations/. (agent")).toBe(true);
  });

  test("keel_recall lists and searches the project's other Pi sessions", async () => {
    const other = pi.SessionManager.create(work, join(work, "sessions"));
    other.appendMessage({ role: "user", content: "Rotate the staging API key", timestamp: now() });
    other.appendMessage({ role: "assistant", content: [{ type: "text", text: "Rotated the staging key and updated the vault." }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: now(), usage });
    await other.flush?.();
    const short = other.getSessionId().replace(/-/g, "").slice(0, 8);
    const tool = agentTool("keel_recall");
    const listed = (await tool.execute("s", { mode: "sessions" }, undefined, undefined)).content[0].text;
    expect(listed).toContain(`${short} · `);
    expect(listed).toContain('"Rotate the staging API key"');
    const found = (await tool.execute("s", { query: "vault", scope: "project" }, undefined, undefined)).content[0].text;
    expect(found).toContain(`[session ${short}] #1 [assistant]`);
  });

  test("/pi-vcc-evict takes old turns out of the next request whole, and keel_recall still reads them", async () => {
    user("Write the release notes for 2.0");
    assistant([{ type: "text", text: "Done." }], "stop");
    user("Tag the release");
    assistant([{ type: "text", text: "Done." }], "stop");
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
      const recall = agentTool("keel_recall");
      const expanded = (await recall.execute("x", { expand: [n] }, undefined, undefined)).content[0].text;
      expect(expanded).toContain(`Expanded #${n}:`);
    } finally {
      writeFileSync(config, saved);
    }
  });

});
