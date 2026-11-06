// A long coding session with planted facts at known depths, run by omp (or Pi,
// with OMP_VCC_LH_HOST=pi or `host: "pi"`) with a real model, then scored: which facts the final summary still carries, whether
// it points at where each one lives (an exact `(#N)` ref, or a [History Index]
// range that names it), and whether vcc_recall finds each one with a reworded
// query.
//
// Nothing here stands in for omp or for a model. The model is a real provider,
// set up as a user sets one up in omp (a `models.yml` provider whose key omp reads
// from the environment): DeepSeek V4.1 Flash on OpenScale, run when
// OMP_VCC_LH_API_KEY holds a key for it. OMP_VCC_LH_BASE_URL, OMP_VCC_LH_MODEL
// and OMP_VCC_LH_API (`openai-completions`) point it elsewhere. Each turn is a
// request telling the agent what to do; omp's agent loop runs it with the agent's
// own calls to omp's real tools, on a real project in a real git repository with
// real tests (`bun test`: each turn's pass once its edit is made, and turn 25's
// fails on rounding until the agent fixes it) and a dev-server script that prints
// its port. omp counts the context from the
// provider's usage, runs its threshold checks and its idle maintenance (every
// `compactEvery` turns), prepares each compaction and commits it; omp-vcc is
// loaded from this package as omp loads it for a user. On Pi the same turns go
// through Pi's agent loop, tools and threshold check (a `models.json` provider),
// and since Pi has no idle maintenance, Pi's own /compact runs every
// `compactEvery` turns instead (tests/support/host-session.ts). Recall runs
// through the session's own vcc_recall tool. Used by tests/long-horizon.test.ts and
// scripts/benchmark-long-horizon.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { indexById } from "../../src/core/session-file";
import { restoreOriginals } from "../../src/core/raw-store";
import { openHostSession, realModel, textOf, type Host, type HostSession } from "./host-session";

export { LONG_HORIZON_MODEL, realModel } from "./host-session";

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
  /** The host the session runs in: OMP_VCC_LH_HOST, omp by default. */
  host?: Host;
  turns?: number;
  /** omp's idle maintenance (Pi's /compact) runs after every this many turns. */
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
  host: Host;
  turns: number;
  /** Compactions the host committed: its periodic passes (omp's idle pass, Pi's /compact), and any threshold pass it decided on. */
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

interface TurnPlan {
  /** The request: what the agent is asked to do this turn. */
  user: string;
  /** Files written before the turn: the module it edits (a fresh copy, so its edit applies) and its tests. */
  files: Record<string, string>;
}

const moduleText = (comp: string, feature: string, t: number, withTotal: boolean): string =>
  [
    `// ${comp}: ${feature}, revision ${t}`,
    ...Array.from({ length: 60 }, (_, i) => `export function ${comp}Step${i}(input: ${comp}Input) { return ${feature.split(" ")[1]}(input, ${i}); }`),
    ...(withTotal ? ["export const total = (cents: number) => Math.floor(cents);"] : []),
  ].join("\n") + "\n";

/** What turn `t` asks of the agent, and the files and test results it will find. */
const planTurn = (t: number, needle: Needle | undefined): TurnPlan => {
  const comp = COMPONENTS[t % COMPONENTS.length];
  const verb = VERBS[(t * 3) % VERBS.length];
  const feature = FEATURES[(t * 5) % FEATURES.length];
  const file = `src/${comp}/${feature.split(" ")[1]}.ts`;
  const readPath = needle?.kind === "early_file" ? "src/legacy/exporter.ts" : file;
  const testFile = `tests/${comp}.test.ts`;
  const test = `bun test ${testFile}`;
  const lead =
    needle?.kind === "constraint"
      ? `Before you start on ${comp}: never edit anything under migrations/ — those files are generated. Now ${verb} ${feature} of ${comp}.`
      : needle?.kind === "mid_request"
        ? `For webhook delivery we need a rate limit of 40 requests per minute per tenant. Please ${verb} ${feature} of ${comp} with that in mind.`
        : `Next: ${verb} ${feature} of ${comp}.`;
  const work = [
    ...(needle?.kind === "tool_value" ? ["first run `bun scripts/dev-server.ts --print-port` to see which port the dev server uses"] : []),
    // The failure is planted by having the agent see it before it changes anything.
    ...(needle?.kind === "fixed_error" ? [`first run \`${test}\` before changing anything, and note which test fails`] : []),
    `read ${readPath} and replace \`${comp}Step1(\` with \`${comp}Step1Checked(\` in it`,
    ...(needle?.kind === "fixed_error"
      ? [`replace \`Math.floor(\` with \`Math.ceil(\` in ${file}, which the failing rounds totals test points at`, `run \`${test}\` again`]
      : [`run \`${test}\``]),
    ...(t % 5 === 0 && t > 0 ? [`commit with \`git commit -am "feat(${comp}): ${verb} ${feature}"\``] : []),
  ];
  const reply =
    needle?.kind === "decision"
      ? `Decision: sessions are stored in SQLite rather than Redis, because the deploy host has no Redis. ${comp} is done.`
      : `Done: ${verb} ${feature} of ${comp}; tests pass.`;
  const user = `${lead} Steps: ${work.join("; then ")}. Do only that, then reply with this one line: ${reply}`;
  // The tests pass once the edit is made; turn 25's also check the total, which rounds down until it is fixed.
  const fn = `${comp}Step1Checked`;
  const tests = [
    'import { describe, expect, it } from "bun:test";',
    `import * as mod from "../${readPath.replace(/\.ts$/, "")}";`,
    "",
    `describe("${comp}", () => {`,
    `  it("has ${fn}", () => expect(typeof (mod as any).${fn}).toBe("function"));`,
    ...Array.from({ length: 11 }, (_, i) => `  it("keeps ${comp}Step${i + 2}", () => expect(typeof (mod as any).${comp}Step${i + 2}).toBe("function"));`),
    ...(needle?.kind === "fixed_error" ? ['  it("rounds totals", () => expect((mod as any).total(1049.5)).toBe(1050));'] : []),
    "});",
    "",
  ].join("\n");
  return { user, files: { [readPath]: moduleText(comp, feature, t, needle?.kind === "fixed_error"), [testFile]: tests } };
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

/** The project the session works on: every module it will touch, committed, and the scripts its commands run. */
const createProject = (proj: string, plans: TurnPlan[]) => {
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), content);
  };
  for (const plan of plans) for (const [path, content] of Object.entries(plan.files)) write(path, content);
  write("scripts/dev-server.ts", 'const PORT = 48213;\nif (process.argv.includes("--print-port")) console.log(`dev server listening on port ${PORT}`);\n');
  write("package.json", '{ "name": "billing-suite", "private": true, "type": "module" }\n');
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
  if (!realModel({ keyFile: true })) throw new Error("long-horizon: set OMP_VCC_LH_API_KEY to a key for DeepSeek V4.1 Flash on OpenScale (tests/support/host-session.ts)");
  const work = mkdtempSync(join(tmpdir(), "omp-vcc-long-horizon-"));
  let hostSession: HostSession | undefined;
  try {
    const needles = NEEDLES(turns).map((n) => ({ ...n }));
    const byTurn = new Map(needles.map((n) => [n.turn, n]));
    const plans = Array.from({ length: turns }, (_, t) => planTurn(t, byTurn.get(t)));
    const proj = join(work, "proj");
    createProject(proj, plans);
    hostSession = await openHostSession({ host: options.host, work, cwd: proj, contextWindow: options.contextWindow, config: options.config });
    const { session, sessionManager } = hostSession;

    for (let t = 0; t < turns; t++) {
      const plan = plans[t];
      for (const [path, content] of Object.entries(plan.files)) writeFileSync(join(proj, path), content);
      await session.prompt(plan.user);
      const pin = options.pins?.[t];
      if (pin) await hostSession.tool("vcc_pin").execute("pin", { note: pin }, undefined, undefined);
      // omp's idle pass; on Pi, which has none, Pi's /compact.
      if ((t + 1) % compactEvery === 0) await hostSession.periodicCompaction();
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
    const numberOf = indexById(entries);
    const stored = entries.filter((e: any) => e.type === "message" && e.message);
    const originals = restoreOriginals(stored.map((e: any) => e.message), stored.map((e: any) => e.id), sessionManager.getSessionFile());
    const messages = stored.map((e: any, i: number) => ({ id: e.id, message: originals[i] }));
    const at = (pred: (m: any) => boolean): number | undefined => {
      const e = messages.find((x: any) => pred(x.message));
      return e ? numberOf.get(e.id) : undefined;
    };
    for (const needle of needles) {
      if (needle.kind === "early_commit") {
        const commit = messages.find((x: any) => x.message.role === "toolResult" && textOf(x.message).includes(`feat(${COMPONENTS[needle.turn % COMPONENTS.length]}):`));
        needle.key = textOf(commit?.message).match(/\[main ([0-9a-f]{7,})\]/)?.[1] ?? "(no commit)";
        needle.index = commit ? numberOf.get(commit.id) : undefined;
        continue;
      }
      needle.index = at((m) => {
        if (needle.kind === "constraint" || needle.kind === "mid_request") return m.role === "user" && textOf(m).includes(needle.key);
        if (needle.kind === "decision") return m.role === "assistant" && textOf(m).includes(needle.key);
        if (needle.kind === "tool_value") return m.role === "toolResult" && textOf(m).includes(needle.key);
        if (needle.kind === "fixed_error") return m.role === "toolResult" && m.isError === true && textOf(m).includes(needle.key);
        // early_file: the edit of the file (however the agent spelled its path).
        return m.role === "assistant" && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "toolCall" && p.name === "edit" && JSON.stringify(p.arguments ?? {}).includes(needle.key));
      });
    }

    const recallTool = hostSession.tool("vcc_recall");
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
      host: hostSession.host,
      turns,
      compactions: compactionEntries.length,
      byOmpVcc: compactionEntries.filter((e: any) => e.details?.compactor === "omp-vcc").length,
      summaryChars,
      sectionChars,
      needles: scores,
      finalSummary,
    };
  } finally {
    await hostSession?.close();
    rmSync(work, { recursive: true, force: true });
  }
};
