// A long synthetic coding session with planted facts at known depths, compacted
// many times through the real Pi hook, then scored: which facts the final summary
// still carries, whether it points at where each one lives (an exact `(#N)` ref,
// or a [History Index] range that names it), and whether vcc_recall finds each
// one with a reworded query. Used by tests/long-horizon.test.ts and
// scripts/benchmark-long-horizon.ts. Deterministic: no clock, no randomness.
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook } from "../../src/hooks/before-compact";
import { parseToolRequest } from "../../src/core/recall-request";
import { openRecallView, runRecall } from "../../src/core/recall-run";
import { TOOL_PAGING_HINTS } from "../../src/tools/recall-spec";

export type NeedleKind = "constraint" | "decision" | "tool_value" | "early_file" | "early_commit" | "fixed_error" | "mid_request";

export interface Needle {
  kind: NeedleKind;
  turn: number;
  /** Text that shows the fact is in the summary. */
  key: string;
  /** How an agent might ask for it later: shares some words with the fact, not its phrasing. */
  query: string;
  /** A component word the fact belongs to, used to check index ranges. */
  topic: string;
  /** Session-wide #N of the entry holding the fact (set while generating). */
  index?: number;
}

export interface LongHorizonOptions {
  turns?: number;
  compactEvery?: number;
  /** Runs before the temp session is removed: extra queries for debugging. */
  inspect?: (recall: (params: Record<string, unknown>) => string, needles: Needle[]) => void;
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
  compactions: number;
  summaryChars: number[];
  needles: NeedleScore[];
  finalSummary: string;
}

const COMPONENTS = ["auth", "billing", "search", "cache", "upload", "notify", "report", "export", "sync", "audit", "queue", "webhook"];
const VERBS = ["add retries to", "add metrics to", "clean up", "add validation to", "speed up", "add logging to", "fix pagination in", "add tests for"];
const FEATURES = ["the client", "the handler", "the worker", "the scheduler", "the parser", "the serializer"];

const hash = (n: number): string => ((n * 2654435761) >>> 0).toString(16).padStart(8, "0").slice(0, 7);

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Planted facts, by turn. Early ones have to survive many compactions. */
export const NEEDLES = (turns: number): Needle[] => [
  { kind: "constraint", turn: 2, key: "never edit anything under migrations/", query: "migrations directory rule", topic: "migrations" },
  { kind: "early_file", turn: 4, key: "src/legacy/exporter.ts", query: "legacy exporter changes", topic: "legacy" },
  { kind: "early_commit", turn: 5, key: hash(5), query: `commit for the ${COMPONENTS[5]} work`, topic: COMPONENTS[5] },
  { kind: "decision", turn: 9, key: "SQLite rather than Redis", query: "why sqlite for sessions", topic: "sessions" },
  { kind: "tool_value", turn: 14, key: "48213", query: "dev server port", topic: "server" },
  // Turn 25 is a billing turn (COMPONENTS[25 % 12]).
  { kind: "fixed_error", turn: 25, key: "rounds totals", query: "billing rounding failure", topic: "billing" },
  { kind: "mid_request", turn: Math.floor(turns / 2), key: "rate limit of 40 requests per minute", query: "webhook rate limit", topic: "webhook" },
];

interface Entry { type: string; id: string; [key: string]: unknown }

/**
 * The session's turns, one function per turn that writes its messages through
 * `push` (which returns the message's session-wide #N). The Pi harness below
 * pushes into an entry list; a host test can push into its own session.
 */
export const generateTurns = (turns: number, needles: Needle[], push: (message: Record<string, unknown>) => number) => {
  const user = (text: string) => push({ role: "user", content: text });
  const assistant = (content: unknown[], stopReason = "toolUse") => push({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason });
  const call = (callId: string, name: string, args: Record<string, unknown>, text?: string) =>
    assistant([...(text ? [{ type: "text", text }] : []), { type: "toolCall", id: callId, name, arguments: args }]);
  const result = (callId: string, name: string, text: string, isError = false) =>
    push({ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError });

  const byTurn = new Map(needles.map((n) => [n.turn, n]));
  const turnFns: Array<() => void> = [];
  for (let t = 0; t < turns; t++) {
    const comp = COMPONENTS[t % COMPONENTS.length];
    const verb = VERBS[(t * 3) % VERBS.length];
    const feature = FEATURES[(t * 5) % FEATURES.length];
    const file = `src/${comp}/${feature.split(" ")[1]}.ts`;
    const needle = byTurn.get(t);
    turnFns.push(() => {
      const c = `c${t}`;
      if (needle?.kind === "constraint") {
        needle.index = user(`Before you start on ${comp}: never edit anything under migrations/ — those files are generated. Now ${verb} ${feature} of ${comp}.`);
      } else if (needle?.kind === "mid_request") {
        needle.index = user(`For webhook delivery we need a rate limit of 40 requests per minute per tenant. Please ${verb} ${feature} of ${comp} with that in mind.`);
      } else {
        user(`Next: ${verb} ${feature} of ${comp}.`);
      }
      const readPath = needle?.kind === "early_file" ? "src/legacy/exporter.ts" : file;
      call(`${c}r`, "read", { path: readPath }, `Looking at ${readPath}.`);
      result(`${c}r`, "read", Array.from({ length: 60 }, (_, i) => `export function ${comp}Step${i}(input: ${comp}Input) { return ${feature.split(" ")[1]}(input, ${i}); }`).join("\n"));
      const editIndex = call(`${c}e`, "edit", { path: readPath, oldText: `${comp}Step1(`, newText: `${comp}Step1Checked(` });
      if (needle?.kind === "early_file") needle.index = editIndex;
      result(`${c}e`, "edit", "Applied 1 edit.");
      if (needle?.kind === "tool_value") {
        call(`${c}p`, "bash", { command: "node scripts/dev-server.js --print-port" });
        needle.index = result(`${c}p`, "bash", "dev server listening on port 48213");
      }
      if (needle?.kind === "fixed_error") {
        call(`${c}t`, "bash", { command: `bun test tests/${comp}.test.ts` });
        needle.index = result(`${c}t`, "bash", `FAIL tests/${comp}.test.ts > rounds totals: expected 1050, got 1049\n1 fail`, true);
        call(`${c}f`, "edit", { path: file, oldText: "Math.floor(", newText: "Math.ceil(" }, "Switching the total to Math.ceil.");
        result(`${c}f`, "edit", "Applied 1 edit.");
      }
      call(`${c}v`, "bash", { command: `bun test tests/${comp}.test.ts` });
      result(`${c}v`, "bash", `12 pass\n0 fail\nRan 12 tests across 1 file.`);
      if (t % 5 === 0 && t > 0) {
        call(`${c}g`, "bash", { command: `git commit -am "feat(${comp}): ${verb} ${feature}"` });
        const commitIndex = result(`${c}g`, "bash", `[main ${hash(t)}] feat(${comp}): ${verb} ${feature}\n 1 file changed`);
        if (needle?.kind === "early_commit") needle.index = commitIndex;
      }
      const text = needle?.kind === "decision"
        ? `Decision: sessions are stored in SQLite rather than Redis, because the deploy host has no Redis. ${comp} is done.`
        : `Done: ${verb} ${feature} of ${comp}; tests pass.`;
      const finalIndex = assistant([{ type: "text", text }], "stop");
      if (needle?.kind === "decision") needle.index = finalIndex;
    });
  }
  return turnFns;
};

const buildSession = (turns: number, needles: Needle[]) => {
  const entries: Entry[] = [];
  let id = 0;
  let messageIndex = 0;
  const push = (message: Record<string, unknown>): number => {
    const entry: Entry = { type: "message", id: `e${++id}`, parentId: id > 1 ? `e${id - 1}` : null, timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(), message: { timestamp: 1_700_000_000_000 + id * 1000, ...message } };
    entries.push(entry);
    return messageIndex++;
  };
  return { entries, turnFns: generateTurns(turns, needles, push) };
};

/** The summary wraps long lines; compare with whitespace collapsed. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

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

export const runLongHorizon = (options: LongHorizonOptions = {}): LongHorizonResult => {
  const turns = options.turns ?? 60;
  const compactEvery = options.compactEvery ?? 6;
  const dir = mkdtempSync(join(tmpdir(), "pi-vcc-long-horizon-"));
  const previousConfig = process.env.PI_VCC_CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = join(dir, "config.json");
  writeFileSync(process.env.PI_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
  const sessionFile = join(dir, "session.jsonl");
  try {
    const needles = NEEDLES(turns).map((n) => ({ ...n }));
    const { entries, turnFns } = buildSession(turns, needles);
    let handler: any;
    registerBeforeCompactHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } } as any, "1.1.0");
    const sessionManager = {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionFile: () => sessionFile,
    };
    const writeFile = () =>
      writeFileSync(sessionFile, [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date(0).toISOString(), cwd: dir }), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n");

    let previousSummary: string | undefined;
    const summaryChars: number[] = [];
    let compactions = 0;
    for (let t = 0; t < turns; t++) {
      turnFns[t]();
      if ((t + 1) % compactEvery !== 0) continue;
      writeFile();
      const chars = entries.reduce((sum, e) => sum + JSON.stringify((e as any).message?.content ?? "").length, 0);
      const out = handler({
        type: "session_before_compact",
        preparation: { previousSummary, fileOps: { read: [], written: [], edited: [] }, tokensBefore: Math.round(chars / 4) },
        branchEntries: entries,
        customInstructions: undefined,
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      }, { sessionManager, ui: { notify: () => {} } });
      if (!out?.compaction) continue;
      compactions++;
      previousSummary = out.compaction.summary;
      summaryChars.push(previousSummary!.length);
      entries.push({
        type: "compaction", id: `k${compactions}`, parentId: entries[entries.length - 1].id,
        timestamp: new Date(0).toISOString(), summary: previousSummary, firstKeptEntryId: out.compaction.firstKeptEntryId,
        tokensBefore: out.compaction.tokensBefore, details: out.compaction.details,
      });
    }
    writeFile();
    const finalSummary = previousSummary ?? "";
    const scores: NeedleScore[] = needles.map((needle) => {
      const request = parseToolRequest({ query: needle.query });
      const view = openRecallView(sessionFile, request.scope, sessionManager);
      const text = runRecall(request, view, TOOL_PAGING_HINTS);
      const hits = [...text.matchAll(/^#(\d+) \[/gm)].map((m) => Number(m[1]));
      // A hit on the entry or its neighbour counts: a tool call and its result
      // are adjacent, and recall shows the hit's surroundings on request.
      const rank = needle.index == null ? -1 : hits.findIndex((h) => Math.abs(h - needle.index!) <= 1);
      return {
        kind: needle.kind,
        turn: needle.turn,
        inSummary: flat(finalSummary).includes(flat(needle.key)),
        pointed: pointsAt(finalSummary, needle),
        recallRank: rank >= 0 ? rank + 1 : null,
      };
    });
    options.inspect?.((params) => {
      const request = parseToolRequest(params as any);
      return runRecall(request, openRecallView(sessionFile, request.scope, sessionManager), TOOL_PAGING_HINTS);
    }, needles);
    return { turns, compactions, summaryChars, needles: scores, finalSummary };
  } finally {
    if (previousConfig === undefined) delete process.env.PI_VCC_CONFIG_PATH;
    else process.env.PI_VCC_CONFIG_PATH = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  }
};
