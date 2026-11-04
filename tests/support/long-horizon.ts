// A long coding session with planted facts at known depths, run by omp itself,
// then scored: which facts the final summary still carries, whether it points at
// where each one lives (an exact `(#N)` ref, or a [History Index] range that
// names it), and whether vcc_recall finds each one with a reworded query.
//
// Nothing here stands in for omp. omp's agent loop runs every turn against omp's
// own mock provider (@oh-my-pi/pi-ai/providers/mock), scripted to make the
// session's tool calls and to report usage for the request omp actually built
// (its system prompt, its tool schemas, the context). omp's real read, edit and
// bash tools run on a real project in a real git repository, whose
// `scripts/test` prints the turn's planned test results (so a failing test can be
// planted) and `scripts/dev-server` a port. omp counts the context, runs its threshold checks and its idle
// maintenance (every `compactEvery` turns), prepares each compaction and commits
// it; omp-vcc is loaded from this package as omp loads it for a user. Recall
// runs through the session's own vcc_recall tool. Used by
// tests/long-horizon.test.ts, tests/pins.test.ts and
// scripts/benchmark-long-horizon.ts.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { buildGlobalIndexById } from "../../src/core/global-indices";
import { restoreOriginals } from "../../src/core/raw-store";

const REPO = resolve(import.meta.dir, "../..");

export type NeedleKind = "constraint" | "decision" | "tool_value" | "early_file" | "early_commit" | "fixed_error" | "mid_request";

export interface Needle {
  kind: NeedleKind;
  turn: number;
  /** Text that shows the fact is in the summary (a commit's: its hash, known once git made it). */
  key: string;
  /** How an agent might ask for it later: shares some words with the fact, not its phrasing. */
  query: string;
  /** A component word the fact belongs to, used to check index ranges. */
  topic: string;
  /** Session-wide #N of the entry holding the fact (found after the run). */
  index?: number;
}

export interface LongHorizonOptions {
  turns?: number;
  /** omp's idle maintenance runs after every this many turns. */
  compactEvery?: number;
  /** Pin a note with the vcc_pin tool at the end of these turns. */
  pins?: Record<number, string>;
  /** The model's context window (default 128K): omp's trigger, and so the budgets, follow it. */
  contextWindow?: number;
  /** omp-vcc settings for the run, over `overrideDefaultCompaction: true` (e.g. `{ workingSet: false }`). */
  config?: Record<string, unknown>;
  /** Runs before the temp session is removed: extra queries for debugging. */
  inspect?: (recall: (params: Record<string, unknown>) => Promise<string>, needles: Needle[]) => Promise<void> | void;
}

export interface NeedleScore {
  kind: NeedleKind;
  turn: number;
  inSummary: boolean;
  pointed: boolean;
  recallRank: number | null;
}

export interface LongHorizonResult {
  turns: number;
  /** Compactions omp committed: its idle passes, and any threshold pass it decided on. */
  compactions: number;
  /** Of those, the ones omp-vcc wrote (all of them, when it works). */
  byOmpVcc: number;
  summaryChars: number[];
  /** The same without [Working Set], which is sized from the landing room, not the sections. */
  sectionChars: number[];
  needles: NeedleScore[];
  finalSummary: string;
}

const COMPONENTS = ["auth", "billing", "search", "cache", "upload", "notify", "report", "export", "sync", "audit", "queue", "webhook"];
const VERBS = ["add retries to", "add metrics to", "clean up", "add validation to", "speed up", "add logging to", "fix pagination in", "add tests for"];
const FEATURES = ["the client", "the handler", "the worker", "the scheduler", "the parser", "the serializer"];

/** Planted facts, by turn. Early ones have to survive many compactions. */
export const NEEDLES = (turns: number): Needle[] => [
  { kind: "constraint", turn: 2, key: "never edit anything under migrations/", query: "migrations directory rule", topic: "migrations" },
  { kind: "early_file", turn: 4, key: "src/legacy/exporter.ts", query: "legacy exporter changes", topic: "legacy" },
  { kind: "early_commit", turn: 5, key: "", query: `commit for the ${COMPONENTS[5]} work`, topic: COMPONENTS[5] },
  { kind: "decision", turn: 9, key: "SQLite rather than Redis", query: "why sqlite for sessions", topic: "sessions" },
  { kind: "tool_value", turn: 14, key: "48213", query: "dev server port", topic: "server" },
  // Turn 25 is a billing turn (COMPONENTS[25 % 12]).
  { kind: "fixed_error", turn: 25, key: "rounds totals", query: "billing rounding failure", topic: "billing" },
  { kind: "mid_request", turn: Math.floor(turns / 2), key: "rate limit of 40 requests per minute", query: "webhook rate limit", topic: "webhook" },
];

type Part = { type: "text"; text: string } | { type: "toolCall"; name: string; arguments: Record<string, unknown> };
interface Step { content: Part[] }
interface TurnPlan {
  user: string;
  /** Files written before the turn (each turn edits a fresh copy, so its edit applies). */
  files: Record<string, string>;
  /** What `scripts/test <file>` prints this turn, in call order, by test file. */
  tests: Record<string, Array<{ out: string; code: number }>>;
  steps: Step[];
}

const text = (t: string): Part => ({ type: "text", text: t });
const call = (name: string, args: Record<string, unknown>): Part => ({ type: "toolCall", name, arguments: args });

const moduleText = (comp: string, feature: string, t: number, withTotal: boolean): string =>
  [
    `// ${comp}: ${feature}, revision ${t}`,
    ...Array.from({ length: 60 }, (_, i) => `export function ${comp}Step${i}(input: ${comp}Input) { return ${feature.split(" ")[1]}(input, ${i}); }`),
    ...(withTotal ? ["export const total = (cents: number) => Math.floor(cents);"] : []),
  ].join("\n") + "\n";

/** What turn `t` does: the request, the files it works on, and the agent's steps. */
const planTurn = (t: number, needle: Needle | undefined): TurnPlan => {
  const comp = COMPONENTS[t % COMPONENTS.length];
  const verb = VERBS[(t * 3) % VERBS.length];
  const feature = FEATURES[(t * 5) % FEATURES.length];
  const file = `src/${comp}/${feature.split(" ")[1]}.ts`;
  const readPath = needle?.kind === "early_file" ? "src/legacy/exporter.ts" : file;
  const testFile = `tests/${comp}.test.ts`;
  const testArgs = `./scripts/test ${testFile}`;
  const pass = { out: "12 pass\n0 fail\nRan 12 tests across 1 file.", code: 0 };
  const user =
    needle?.kind === "constraint"
      ? `Before you start on ${comp}: never edit anything under migrations/ — those files are generated. Now ${verb} ${feature} of ${comp}.`
      : needle?.kind === "mid_request"
        ? `For webhook delivery we need a rate limit of 40 requests per minute per tenant. Please ${verb} ${feature} of ${comp} with that in mind.`
        : `Next: ${verb} ${feature} of ${comp}.`;
  const steps: Step[] = [
    { content: [text(`Looking at ${readPath}.`), call("read", { path: readPath })] },
    { content: [call("edit", { path: readPath, old_string: `${comp}Step1(`, new_string: `${comp}Step1Checked(` })] },
  ];
  const tests: TurnPlan["tests"] = { [comp]: [] };
  if (needle?.kind === "tool_value") steps.push({ content: [call("bash", { command: "./scripts/dev-server --print-port" })] });
  if (needle?.kind === "fixed_error") {
    steps.push({ content: [call("bash", { command: testArgs })] });
    tests[comp].push({ out: `FAIL tests/${comp}.test.ts > rounds totals: expected 1050, got 1049\n1 fail`, code: 1 });
    steps.push({ content: [text("Switching the total to Math.ceil."), call("edit", { path: file, old_string: "Math.floor(", new_string: "Math.ceil(" })] });
  }
  steps.push({ content: [call("bash", { command: testArgs })] });
  tests[comp].push(pass);
  if (t % 5 === 0 && t > 0) steps.push({ content: [call("bash", { command: `git commit -am "feat(${comp}): ${verb} ${feature}"` })] });
  steps.push({
    content: [
      text(
        needle?.kind === "decision"
          ? `Decision: sessions are stored in SQLite rather than Redis, because the deploy host has no Redis. ${comp} is done.`
          : `Done: ${verb} ${feature} of ${comp}; tests pass.`,
      ),
    ],
  });
  return { user, files: { [readPath]: moduleText(comp, feature, t, needle?.kind === "fixed_error") }, tests, steps };
};

/** The summary wraps long lines; compare with whitespace collapsed. */
const flat = (s: string): string => s.replace(/\s+/g, " ");

const pointsAt = (summary: string, needle: Needle): boolean => {
  if (needle.index == null) return false;
  if (summary.includes(`(#${needle.index})`)) return true;
  // A [History Index] line "#a–#b …" whose range covers the fact and names its topic.
  for (const line of summary.replace(/\n[ \t]+(?=\S)/g, " ").split("\n")) {
    const m = line.match(/#(\d+)\s*[-–]\s*#?(\d+)/);
    if (!m) continue;
    const [lo, hi] = [Number(m[1]), Number(m[2])];
    if (needle.index >= lo && needle.index <= hi && line.toLowerCase().includes(needle.topic.toLowerCase())) return true;
  }
  return false;
};

const run = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};

/** A message as a provider receives it: its role, text, and tool calls with their arguments. */
const requestChars = (m: any): number => {
  const parts = typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [];
  return 16 + String(m?.role ?? "").length + parts.reduce((n: number, p: any) => n + (p?.type === "text" ? String(p.text ?? "").length : p?.type === "toolCall" ? String(p.name ?? "").length + JSON.stringify(p.arguments ?? {}).length : p?.type === "thinking" ? String(p.thinking ?? "").length : 0), 0);
};

const textOf = (m: any): string =>
  typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => (p?.type === "text" ? p.text : "")).join("\n") : "";

/** The project the session works on: every module it will touch, committed, and the scripts its commands run. */
const createProject = (proj: string, plans: TurnPlan[]) => {
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), content);
  };
  for (const plan of plans) for (const [path, content] of Object.entries(plan.files)) write(path, content);
  // The project's own scripts, plain sh: what omp's bash runs is the project's, as it would be.
  write("scripts/dev-server", '#!/bin/sh\n[ "$1" = "--print-port" ] && echo "dev server listening on port 48213"\n');
  write("scripts/test", [
    "#!/bin/sh",
    "# Prints the next planned result for this test file (.plan/<name>/<n>.out, exit code in <n>.code).",
    'dir=".plan/$(basename "$1" .test.ts)"',
    'n=$(ls "$dir" 2>/dev/null | grep "\\.out$" | sort -n | head -1)',
    '[ -z "$n" ] && { echo "no planned result for $1" >&2; exit 127; }',
    'cat "$dir/$n"; code=$(cat "$dir/${n%.out}.code"); rm -f "$dir/$n" "$dir/${n%.out}.code"; exit "$code"',
    "",
  ].join("\n"));
  chmodSync(join(proj, "scripts/dev-server"), 0o755);
  chmodSync(join(proj, "scripts/test"), 0o755);
  write(".gitignore", ".plan/\n");
  write("migrations/001_init.sql", "-- generated\n");
  run(proj, "git", "init", "-q", "-b", "main");
  run(proj, "git", "config", "user.name", "omp-vcc test");
  run(proj, "git", "config", "user.email", "test@omp-vcc.invalid");
  run(proj, "git", "config", "commit.gpgsign", "false");
  run(proj, "git", "add", "-A");
  run(proj, "git", "commit", "-q", "-m", "init");
};

export const runLongHorizon = async (options: LongHorizonOptions = {}): Promise<LongHorizonResult> => {
  const turns = options.turns ?? 60;
  const compactEvery = options.compactEvery ?? 6;
  const work = mkdtempSync(join(tmpdir(), "omp-vcc-long-horizon-"));
  const saved = ["PI_CODING_AGENT_DIR", "OMP_VCC_CONFIG_PATH", "ANTHROPIC_API_KEY"].map((k) => [k, process.env[k]] as const);
  let session: any;
  try {
    const needles = NEEDLES(turns).map((n) => ({ ...n }));
    const byTurn = new Map(needles.map((n) => [n.turn, n]));
    const plans = Array.from({ length: turns }, (_, t) => planTurn(t, byTurn.get(t)));
    const proj = join(work, "proj");
    createProject(proj, plans);

    process.env.PI_CODING_AGENT_DIR = join(work, "agent");
    process.env.OMP_VCC_CONFIG_PATH = join(work, "omp-vcc-config.json");
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, ...options.config }));
    // omp runs an automatic pass only through a method it can use, which needs a
    // credential for the provider of the model its summary methods fall back to.
    // Nothing is sent with it: every summary is omp-vcc's (as in tests/omp-host.test.ts).
    process.env.ANTHROPIC_API_KEY ??= "omp-vcc-test-not-a-key";
    const omp: any = await import("@oh-my-pi/pi-coding-agent");
    const mock: any = await import("@oh-my-pi/pi-ai/providers/mock" as string);
    const { initializeExtensions }: any = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init" as string);
    mock.registerMockApi();
    const script: Step[] = [];
    const model = mock.createMockModel({
      // omp's keyless provider: no credential to look up, and nothing is sent anywhere.
      provider: "local",
      contextWindow: options.contextWindow ?? 128_000,
      handler: (ctx: any) => {
        // A side request (no tools offered) is not the agent's turn.
        if (!ctx.tools?.length) return { content: ["ok"] };
        // What a provider tokenizes: the system prompt, each tool's name, description and
        // schema, and each message's text and tool calls (not omp's bookkeeping fields).
        const tools = ctx.tools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters }));
        const promptChars = (ctx.systemPrompt?.length ?? 0) + JSON.stringify(tools).length + ctx.messages.reduce((n: number, m: any) => n + requestChars(m), 0);
        const step = script.shift();
        if (!step) throw new Error("long-horizon: omp asked for more turns than the plan has");
        return { content: step.content, usage: { input: Math.ceil(promptChars / 4), output: 40 } };
      },
    });
    const sessionManager = omp.SessionManager.create(proj, join(work, "sessions"));
    session = (await omp.createAgentSession({
      cwd: proj,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionManager,
      settings: omp.Settings.isolated({
        // omp keeps this much verbatim before asking any hook: let every pass reach omp-vcc.
        "compaction.keepRecentTokens": 1,
        // omp's replace edit (old_string/new_string), as omp picks for many models.
        "edit.mode": "replace",
      }),
      model,
      additionalExtensionPaths: [REPO],
      disableExtensionDiscovery: true,
      enableMCP: false,
      enableLsp: false,
      hasUI: false,
    })).session;
    await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, mode: "rpc", uiContext: new Proxy({}, { get: () => () => undefined }) });

    for (let t = 0; t < turns; t++) {
      const plan = plans[t];
      for (const [path, content] of Object.entries(plan.files)) writeFileSync(join(proj, path), content);
      for (const [name, results] of Object.entries(plan.tests)) {
        const dir = join(proj, ".plan", name);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        results.forEach((r, i) => {
          writeFileSync(join(dir, `${i + 1}.out`), r.out + "\n");
          writeFileSync(join(dir, `${i + 1}.code`), String(r.code));
        });
      }
      script.push(...plan.steps);
      await session.prompt(plan.user);
      if (script.length > 0) throw new Error(`long-horizon: turn ${t} ended with ${script.length} steps left`);
      const pin = options.pins?.[t];
      if (pin) await session.getToolByName("vcc_pin").execute("pin", { note: pin }, undefined, undefined);
      if ((t + 1) % compactEvery === 0) await session.runIdleCompaction();
    }
    await sessionManager.flush?.();

    const compactionEntries = sessionManager.getBranch().filter((e: any) => e.type === "compaction");
    const summaryChars = compactionEntries.map((e: any) => e.summary.length);
    const sectionChars = compactionEntries.map((e: any) => {
      const s: string = e.summary;
      const ws = s.indexOf("[Working Set]");
      if (ws < 0) return s.length;
      const end = s.indexOf("\n\n", ws);
      return s.length - ((end < 0 ? s.length : end) - ws);
    });
    const finalSummary: string = compactionEntries.at(-1)?.summary ?? "";

    // Where each fact landed, by omp-vcc's own #N, in the originals of what omp rewrote in place.
    const entries = sessionManager.getEntries();
    const indexById = buildGlobalIndexById(entries);
    const stored = entries.filter((e: any) => e.type === "message" && e.message);
    const originals = restoreOriginals(stored.map((e: any) => e.message), stored.map((e: any) => e.id), sessionManager.getSessionFile());
    const messages = stored.map((e: any, i: number) => ({ id: e.id, message: originals[i] }));
    const at = (pred: (m: any) => boolean): number | undefined => {
      const e = messages.find((x: any) => pred(x.message));
      return e ? indexById.get(e.id) : undefined;
    };
    for (const needle of needles) {
      if (needle.kind === "early_commit") {
        const commit = messages.find((x: any) => x.message.role === "toolResult" && textOf(x.message).includes(`feat(${COMPONENTS[needle.turn % COMPONENTS.length]}):`));
        needle.key = textOf(commit?.message).match(/\[main ([0-9a-f]{7,})\]/)?.[1] ?? "(no commit)";
        needle.index = commit ? indexById.get(commit.id) : undefined;
        continue;
      }
      needle.index = at((m) => {
        if (needle.kind === "constraint" || needle.kind === "mid_request") return m.role === "user" && textOf(m).includes(needle.key);
        if (needle.kind === "decision") return m.role === "assistant" && textOf(m).includes(needle.key);
        if (needle.kind === "tool_value") return m.role === "toolResult" && textOf(m).includes(needle.key);
        if (needle.kind === "fixed_error") return m.role === "toolResult" && m.isError === true && textOf(m).includes(needle.key);
        // early_file: the edit of the file.
        return m.role === "assistant" && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "toolCall" && p.name === "edit" && p.arguments?.path === needle.key);
      });
    }

    const recallTool = session.getToolByName("vcc_recall");
    const recall = async (params: Record<string, unknown>): Promise<string> =>
      (await recallTool.execute("q", params, undefined, undefined)).content.map((p: any) => p.text ?? "").join("\n");
    const scores: NeedleScore[] = [];
    for (const needle of needles) {
      const hits = [...(await recall({ query: needle.query })).matchAll(/^#(\d+) \[/gm)].map((m) => Number(m[1]));
      // A hit on the entry or its neighbour counts: a tool call and its result
      // are adjacent, and recall shows the hit's surroundings on request.
      const rank = needle.index == null ? -1 : hits.findIndex((h) => Math.abs(h - needle.index!) <= 1);
      scores.push({
        kind: needle.kind,
        turn: needle.turn,
        inSummary: flat(finalSummary).includes(flat(needle.key)),
        pointed: pointsAt(finalSummary, needle),
        recallRank: rank >= 0 ? rank + 1 : null,
      });
    }
    await options.inspect?.(recall, needles);
    return {
      turns,
      compactions: compactionEntries.length,
      byOmpVcc: compactionEntries.filter((e: any) => e.details?.compactor === "omp-vcc").length,
      summaryChars,
      sectionChars,
      needles: scores,
      finalSummary,
    };
  } finally {
    await session?.dispose?.();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(work, { recursive: true, force: true });
  }
};
