// A recorded session on a real host: one session built in a real omp or a
// real Pi with keel loaded from this repository, compacted by command and
// automatically, then recalled. Prints every summary, its details and the
// recall outputs as JSON, which tests/golden.test.ts compares with
// tests/fixtures/golden-<host>.json:
//   bun run tests/support/golden-session.ts omp|pi > tests/fixtures/golden-<host>.json
// The turns are synthetic (a scripted agent's reads, edits, failing and
// passing tests, commits), so the output is the same on every run.
import { mkdtempSync } from "fs";
import { removeDir } from "./session-files";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "../..");
const HOST = process.argv[2];
const work = mkdtempSync(join(tmpdir(), `golden-${HOST}-`));
process.env.PI_CODING_AGENT_DIR = join(work, "agent");
process.env.KEEL_CONFIG_PATH = join(work, "keel-config.json");
process.env.ANTHROPIC_API_KEY ??= "golden-not-a-key";
await Bun.write(process.env.KEEL_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, trackCommands: ["docker", "ssh"], evict: false }));

/** The model's window in each host's recorded session, set rather than read from the host's catalog, which changes between releases. */
const GOLDEN_WINDOW = HOST === "omp" ? 1_000_000 : 200_000;
let session: any, sessionManager: any, model: any, tool: (n: string) => any, auto: (reason: string) => Promise<void>, command: string;
const notices: string[] = [];
if (HOST === "omp") {
  const omp: any = await import(join(REPO, "node_modules/@oh-my-pi/pi-coding-agent/src/index.ts"));
  const { getBundledModels }: any = await import(join(REPO, "node_modules/@oh-my-pi/pi-catalog/src/models.ts"));
  const { initializeExtensions }: any = await import(join(REPO, "node_modules/@oh-my-pi/pi-coding-agent/src/modes/runtime-init.ts"));
  // The window recorded in the fixtures, whatever this omp's catalog says of the model: the summary is sized from it.
  model = { ...getBundledModels("anthropic")[0], contextWindow: GOLDEN_WINDOW };
  sessionManager = omp.SessionManager.create(work, join(work, "sessions"));
  session = (await omp.createAgentSession({
    cwd: work, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager,
    settings: omp.Settings.isolated({ "compaction.keepRecentTokens": 1 }),
    model, additionalExtensionPaths: [REPO], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, hasUI: false,
  })).session;
  const uiContext = new Proxy({}, { get: (_t, k) => (k === "notify" ? (m: string, t?: string) => notices.push(`${t}: ${m}`) : () => undefined) });
  await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, mode: "rpc", uiContext });
  tool = (n) => session.getToolByName(n);
  auto = async () => { await session.runIdleCompaction(); };
  command = "keel";
} else {
  const pi: any = await import(join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
  const modelRuntime = await pi.ModelRuntime.create({ authPath: join(work, "auth.json"), modelsPath: join(work, "models.json") });
  // As on omp: Pi 1.0's catalog gives this model a 1M window, later ones 200K.
  model = { ...modelRuntime.getModel("anthropic", "claude-sonnet-4-5"), contextWindow: GOLDEN_WINDOW };
  const resourceLoader = new pi.DefaultResourceLoader({ cwd: work, agentDir: process.env.PI_CODING_AGENT_DIR, additionalExtensionPaths: [REPO] });
  await resourceLoader.reload();
  sessionManager = pi.SessionManager.create(work, join(work, "sessions"));
  session = (await pi.createAgentSession({ cwd: work, agentDir: process.env.PI_CODING_AGENT_DIR, model, modelRuntime, resourceLoader, sessionManager,
    settingsManager: pi.SettingsManager.inMemory({ compaction: { keepRecentTokens: 1, reserveTokens: 20_000 } }) })).session;
  await session.bindExtensions({ mode: "rpc", uiContext: { notify: (m: string, t?: string) => notices.push(`${t}: ${m}`) } });
  tool = (n) => session.agent.state.tools.find((t: any) => t.name === n);
  auto = async (reason) => { await session._runAutoCompaction(reason, reason === "overflow"); };
  command = "keel";
}

let ts = 1_700_000_000_000;
const now = () => (ts += 1000);
const usage = (n: number) => ({ input: n, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: n + 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = (text: string) => sessionManager.appendMessage({ role: "user", content: text, timestamp: now() });
let tokens = 2000;
const assistant = (content: any[], stopReason = "toolUse") =>
  sessionManager.appendMessage({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: now(), usage: usage((tokens += 1500)) });
const result = (id: string, name: string, text: string, isError = false) =>
  sessionManager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: now() });
let n = 0;
const call = (name: string, args: Record<string, unknown>, out: string, isError = false, text?: string) => {
  const id = `c${++n}`;
  assistant([...(text ? [{ type: "text", text }] : []), { type: "toolCall", id, name, arguments: args }]);
  result(id, name, out, isError);
};
const fileBody = (name: string, lines: number) => Array.from({ length: lines }, (_, i) => `export function ${name}${i}(x: number) { return x * ${i}; }`).join("\n");
const editArgs = (path: string, oldText: string, newText: string) =>
  HOST === "pi" ? { path, edits: [{ oldText, newText }] } : { path, old_string: oldText, new_string: newText };

const turn = (t: number) => {
  const comp = ["auth", "billing", "search", "upload"][t % 4];
  const file = `src/${comp}/service.ts`;
  user(t === 0
    ? "Fix the login bug: users cannot log in after a password reset. Never touch migrations/ — they are generated."
    : t % 7 === 3 ? `Please look at ${file} and explain the ${comp} flow, then tighten the error handling.\n\n\`\`\`ts\nthrow new Error("${comp} failed");\n\`\`\``
    : `Turn ${t}: update ${comp} so that retries back off exponentially (${file}).`);
  call("read", { path: file }, fileBody(comp, 30 + t));
  call("grep", { pattern: `${comp}Retry`, path: "src" }, `${file}:12: const ${comp}Retry = 3;`);
  call("edit", editArgs(file, `return x * ${t};`, `return x * ${t + 1};`), `Successfully replaced 1 block(s) in ${file}.`, false, `Updating ${comp}.`);
  if (t % 5 === 2) call("bash", { command: `bun test tests/${comp}.test.ts` }, `FAIL tests/${comp}.test.ts\n  expected 3, got 2\n1 fail`, true);
  call("bash", { command: `bun test tests/${comp}.test.ts` }, "3 pass\n0 fail");
  if (t % 3 === 0) call("bash", { command: `git commit -am "fix(${comp}): back off on retry ${t}"` }, `[main a${String(t).padStart(6, "0")}] fix(${comp}): back off on retry ${t}\n 1 file changed`);
  if (t % 6 === 4) call("bash", { command: "docker compose restart api 2>&1" }, "Restarting api ... done");
  if (t === 5) call("write", { path: `tests/${comp}-new.test.ts`, content: `test("${comp}", () => {});\n` }, "Wrote 1 line.");
  if (t === 8) sessionManager.appendMessage({ role: "bashExecution", command: "git status --short", output: " M src/auth/service.ts", exitCode: 0, cancelled: false, truncated: false, timestamp: now() });
  if (t === 9) sessionManager.appendMessage({ role: "custom", customType: "ci-status", content: "CI is green on main", display: true, timestamp: now() });
  assistant([{ type: "text", text: `Done with turn ${t}: ${comp} now backs off exponentially, tests pass.` }], "stop");
};

const out: any = { host: HOST, compactions: [], recall: {}, notices };
const stable = (c: any) => {
  const d = { ...(c.details ?? {}) };
  return { summary: c.summary, firstKept: c.firstKeptEntryId ? "set" : "none", tokensBefore: c.tokensBefore, details: d };
};
const record = (label: string) => {
  const c = [...sessionManager.getBranch()].reverse().find((e: any) => e.type === "compaction");
  out.compactions.push({ label, ...(c ? stable(c) : { none: true }) });
};

for (let t = 0; t < 12; t++) turn(t);
await session.prompt(`/${command} keep:2`); await Bun.sleep(700); record("command keep:2");
await tool("keel_pin").execute("p", { note: "Sessions live in SQLite, not Redis." }, undefined, undefined);
for (let t = 12; t < 24; t++) turn(t);
await auto("threshold"); record("auto 1");
for (let t = 24; t < 34; t++) turn(t);
await session.prompt(`/${command}`); await Bun.sleep(700); record("command keep:1");
for (let t = 34; t < 40; t++) turn(t);
await auto(HOST === "pi" ? "overflow" : "threshold"); record("auto 2");

const recall = async (label: string, params: any) => {
  const r = await tool("keel_recall").execute("r", params, undefined, undefined);
  out.recall[label] = r.content.map((p: any) => p.text ?? "").join("\n");
};
await recall("query", { query: "password reset login" });
await recall("query page 2", { query: "retries back off", page: 2 });
await recall("regex", { query: "a0000(1|2)" });
await recall("expand", { expand: [5, 40] });
await recall("range", { range: [20, 45] });
await recall("touched", { mode: "touched" });
await recall("drill", { query: "#2:src/billing/service.ts" });
await recall("scope all", { query: "docker restart", scope: "all" });
await recall("loose", { expand: "#12", scope: "ALL" });
console.log(JSON.stringify(out, null, 1));
await session.dispose?.();
removeDir(work);
process.exit(0);
