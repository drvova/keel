#!/usr/bin/env bun
/**
 * Sample compaction benchmark — TEMPLATE, not a turnkey tool.
 *
 * Measures omp-vcc's ranked brief (`compileRanked`) against the plain
 * contiguous transcript-tail brief (`compile`) on YOUR OWN sessions, using the
 * scoring documented in benchmarks/README.md: weighted fact recall, weighted
 * fact-density, precision, and size.
 *
 * It is deliberately self-contained (fact model + weights + metrics inlined) so
 * you can read it top-to-bottom and adapt the parts that matter for your
 * workflow — especially the fact WEIGHTS (§ "Fact weights") and the command
 * families, which encode what "an important fact" means for you.
 *
 * ── Run (from a clone of this repo, with bun) ────────────────────────────────
 *   bun benchmarks/benchmark.ts --sessions=~/.omp/agent/sessions --limit=200
 *
 * Flags (all optional):
 *   --sessions=DIR   dir of *.jsonl session files (recursed). default: ~/.omp/agent/sessions
 *   --limit=N        cap sessions processed. default: all
 *   --max-blocks=N   ranked selection pool size.        default: 80
 *   --recent=N       recent blocks always kept.         default: 16
 *   --floor=N        min brief budget (chars).          default: 4400
 *   --ceiling=N      max brief budget (chars).          default: 8000
 *   --per-block=N    budget slope (chars per block).    default: 60
 *   --out=DIR        where to write csv/json.           default: benchmarks/out
 *
 * Requires omp's package (a dev dependency of this repo):
 *   @oh-my-pi/pi-coding-agent
 *
 * NOTE: this reads your real session transcripts locally and writes only
 * aggregate metrics + session IDs to --out. It makes no network calls.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";

// Both brief builders come from THIS repo's src/ — the comparison is
// "plain tail (compile) vs ranked (compileRanked)", i.e. the value of ranking.
// To instead reproduce a "vs a previous release" number, install that version
// and import its compile() here as the baseline.
import { compile, compileRanked } from "../src/core/summarize";
import { normalize } from "../src/core/normalize";
import { filterNoise } from "../src/core/filter-noise";
import { extractFiles } from "../src/extract/files";
import { extractCommits, formatCommits } from "../src/extract/commits";
import { extractPath } from "../src/core/tool-args";
import type { FileOps, NormalizedBlock } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const arg = (name: string): string | undefined => {
  const p = `--${name}=`;
  return process.argv.find((a) => a.startsWith(p))?.slice(p.length);
};
const argNum = (name: string, fallback: number): number => {
  const n = Number(arg(name));
  return Number.isFinite(n) ? n : fallback;
};
const expandHome = (p: string): string => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const SESSIONS_DIR = resolve(expandHome(arg("sessions") ?? "~/.omp/agent/sessions"));
const OUT_DIR = resolve(expandHome(arg("out") ?? join(import.meta.dir, "out")));
const LIMIT = argNum("limit", Infinity);
const MAX_BLOCKS = argNum("max-blocks", 80);
const RECENT = argNum("recent", 16);
// Size-relative budget: clamp(perBlock * blockCount, floor, ceiling). See README §5.
const FLOOR = argNum("floor", 4400);
const CEILING = argNum("ceiling", 8000);
const PER_BLOCK = argNum("per-block", 60);

// ─────────────────────────────────────────────────────────────────────────────
// Fact model  (README §3.1) — command families & tool classes
// ─────────────────────────────────────────────────────────────────────────────
const TEST_RE = /(?:\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?[\w:-]*(?:test|spec|check|lint|build|typecheck|tsc)\b|\bnode\s+--test\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bmvn\s+test\b|\bgradle\s+test\b|\btsc\b)/i;
const GH_RE = /(?:^|\s)gh\s+(pr|issue)\s+(\w+)\s+(\d+)/i;
const GH_ANY_RE = /(?:^|\s)gh\s+(pr|issue)\s+(\w+)\b/i;
const GIT_RE = /(?:^|\s)git\s+(\w+)/i;
const SEARCH_RE = /^(?:rg|grep|find)\b/i;
const EDIT_TOOL_RE = /^(edit|write|multiedit|quick_edit|target_edit|apply_patch)$/i;
const READ_TOOL_RE = /^(read|glob|grep|ls|find|semantic_query|semantic_grep|semantic_show)$/i;

interface CommandFact { exactKey: string; semanticKey: string; family: string; failed: boolean; }
interface ToolFact { key: string; family: string; }

const normalizeCommand = (cmd: string): string =>
  cmd.replace(/^\s*cd\s+\S+\s*&&\s*/, "").replace(/\s+/g, " ").trim();

const commandFamily = (cmd: string): string => {
  if (GH_ANY_RE.test(cmd)) return "gh";
  if (GIT_RE.test(cmd)) return "git";
  if (SEARCH_RE.test(cmd)) return "search";
  if (TEST_RE.test(cmd)) return "verify";
  return "other";
};

const semanticCommandKey = (cmd: string): string => {
  const n = normalizeCommand(cmd);
  const gh = n.match(GH_RE);
  if (gh) return `gh:${gh[1].toLowerCase()}:${gh[2].toLowerCase()}:${gh[3]}`;
  const ghAny = n.match(GH_ANY_RE);
  if (ghAny) return `gh:${ghAny[1].toLowerCase()}:${ghAny[2].toLowerCase()}`;
  const git = n.match(GIT_RE);
  if (git) {
    const msg = n.match(/\bgit\s+commit\b[^\n]*?-m\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    if (msg) return `git:commit:${msg[1] ?? msg[2] ?? msg[3]}`;
    return `git:${git[1].toLowerCase()}`;
  }
  if (TEST_RE.test(n)) {
    const runner = n.match(/^\S+/)?.[0] ?? "test";
    const files = [...n.matchAll(/[\w./-]+(?:test|spec)[\w./-]*\.[\w]+|tests\/[\w./-]+/g)].map((m) => m[0]).sort();
    return `verify:${runner}:${files.length ? files.join(",") : n.slice(0, 120)}`;
  }
  if (SEARCH_RE.test(n)) {
    const quoted = n.match(/"([^"]+)"|'([^']+)'/)?.slice(1).find(Boolean);
    const bin = n.match(/^\S+/)?.[0] ?? "search";
    return `search:${bin}:${quoted ?? n.slice(0, 120)}`;
  }
  const [bin = "cmd", sub = ""] = n.split(/\s+/, 2);
  return `${bin}:${sub || n.slice(0, 80)}`;
};

const commandFact = (raw: string, failed = false): CommandFact | null => {
  const n = normalizeCommand(raw);
  if (!n) return null;
  return { exactKey: `cmd:${n}`, semanticKey: semanticCommandKey(n), family: commandFamily(n), failed };
};

// ─────────────────────────────────────────────────────────────────────────────
// Fact weights  (README §3.2) — EDIT THESE to reflect what matters to you.
// ─────────────────────────────────────────────────────────────────────────────
interface Facts {
  filesModified: Set<string>;
  filesRead: Set<string>;
  commits: Set<string>;
  commandsSemantic: Set<string>;
  testCommands: Set<string>;
  failedCommands: Set<string>;
  ghCommands: Set<string>;
  searchCommands: Set<string>;
  editTools: Set<string>;
  readTools: Set<string>;
  commandExactDupes: number;
  toolDupes: number;
}

const WEIGHTS = [
  { ref: "failedCommands", got: "commandsSemantic", weight: 6 }, // error state — most critical
  { ref: "commits", got: "commits", weight: 5 },
  { ref: "filesModified", got: "filesModified", weight: 4 },
  { ref: "testCommands", got: "testCommands", weight: 4 },
  { ref: "editTools", got: "editTools", weight: 4 },
  { ref: "ghCommands", got: "ghCommands", weight: 2 },
  { ref: "filesRead", got: "filesRead", weight: 1 },
  { ref: "searchCommands", got: "searchCommands", weight: 1 },
  { ref: "readTools", got: "readTools", weight: 1 },
  { ref: "commandsSemantic", got: "commandsSemantic", weight: 0.5 }, // generic long tail
] as const satisfies readonly { ref: keyof Facts; got: keyof Facts; weight: number }[];

const asSet = (f: Facts, k: keyof Facts): Set<string> => (f[k] instanceof Set ? (f[k] as Set<string>) : new Set());
const weightedTotal = (ref: Facts): number => WEIGHTS.reduce((t, w) => t + asSet(ref, w.ref).size * w.weight, 0);
const weightedHit = (ref: Facts, got: Facts): number => {
  let hit = 0;
  for (const w of WEIGHTS) {
    const g = asSet(got, w.got);
    for (const k of asSet(ref, w.ref)) if (g.has(k)) hit += w.weight;
  }
  return hit;
};
const weightedRecall = (ref: Facts, got: Facts): number => {
  const total = weightedTotal(ref);
  return total === 0 ? 1 : weightedHit(ref, got) / total; // empty session → 1
};
const weightedFactDensity = (ref: Facts, got: Facts, chars: number): number =>
  chars > 0 ? weightedHit(ref, got) / (chars / 1000) : 0;

const precision = (got: Facts): number => {
  const readOnly = new Set([...got.filesRead].filter((p) => !got.filesModified.has(p)));
  let rest = new Set(got.commandsSemantic);
  const inter = (a: Set<string>) => new Set([...rest].filter((k) => a.has(k)));
  const minus = (a: Set<string>) => new Set([...rest].filter((k) => !a.has(k)));
  const verify = inter(got.testCommands); rest = minus(got.testCommands);
  const gh = inter(got.ghCommands); rest = minus(got.ghCommands);
  const search = inter(got.searchCommands); rest = minus(got.searchCommands);
  const cats = [
    { c: got.commits.size, w: 5 }, { c: got.filesModified.size, w: 4 }, { c: readOnly.size, w: 1 },
    { c: verify.size, w: 4 }, { c: gh.size, w: 2 }, { c: search.size, w: 1 }, { c: rest.size, w: 0.5 },
    { c: got.editTools.size, w: 4 }, { c: got.readTools.size, w: 1 },
  ];
  const denom = cats.reduce((s, x) => s + x.c, 0);
  return denom === 0 ? 0 : cats.reduce((s, x) => s + x.c * x.w, 0) / denom;
};

// ─────────────────────────────────────────────────────────────────────────────
// Extraction helpers
// ─────────────────────────────────────────────────────────────────────────────
const setOf = (items: Iterable<string>): Set<string> => new Set([...items].filter(Boolean));
const union = (...s: Set<string>[]): Set<string> => setOf(s.flatMap((x) => [...x]));
const countDupes = (items: string[]): number => items.length - new Set(items).size;
const stripRenderedRef = (s: string): string =>
  s.replace(/\s+\(#[\d, #]+\)\s*x\d+$/, "").replace(/\s+\(#\d+\)$/, "").trim();

// Join wrapped continuation lines back into one logical line (mirrors the brief renderer).
const logicalLines = (text: string): string[] => {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line) { out.push(line); continue; }
    const starts = /^(?:\[[^\]]+\]|[-*]\s+|\$\s+|\.\.\.\()/.test(line);
    if (starts || out.length === 0) out.push(line);
    else out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`.trimEnd();
  }
  return out;
};

const buildFacts = (parts: {
  filesModified: Set<string>; filesRead: Set<string>; commits: Set<string>;
  commandFacts: CommandFact[]; toolFacts: ToolFact[];
}): Facts => ({
  filesModified: parts.filesModified,
  filesRead: parts.filesRead,
  commits: parts.commits,
  commandsSemantic: setOf(parts.commandFacts.map((c) => c.semanticKey)),
  testCommands: setOf(parts.commandFacts.filter((c) => c.family === "verify").map((c) => c.semanticKey)),
  failedCommands: setOf(parts.commandFacts.filter((c) => c.failed).map((c) => c.semanticKey)),
  ghCommands: setOf(parts.commandFacts.filter((c) => c.family === "gh").map((c) => c.semanticKey)),
  searchCommands: setOf(parts.commandFacts.filter((c) => c.family === "search").map((c) => c.semanticKey)),
  editTools: setOf(parts.toolFacts.filter((t) => t.family === "edit").map((t) => t.key)),
  readTools: setOf(parts.toolFacts.filter((t) => t.family === "read").map((t) => t.key)),
  commandExactDupes: countDupes(parts.commandFacts.map((c) => c.exactKey)),
  toolDupes: countDupes(parts.toolFacts.map((t) => t.key)),
});

// Ground truth: facts from the FULL normalized transcript.
const factsFromBlocks = (blocks: NormalizedBlock[]): Facts => {
  const files = extractFiles(blocks);
  for (const p of files.modified) files.created.delete(p);
  const commandFacts: CommandFact[] = [];
  const toolFacts: ToolFact[] = [];
  for (const b of blocks) {
    if (b.kind === "bash") {
      const f = commandFact((b as any).command, (b as any).exitCode != null && (b as any).exitCode !== 0);
      if (f) commandFacts.push(f);
      continue;
    }
    if (b.kind !== "tool_call" || !b.name) continue;
    if (/^bash$/i.test(b.name) && typeof (b as any).args?.command === "string") {
      const f = commandFact((b as any).args.command);
      if (f) commandFacts.push(f);
      continue;
    }
    const path = extractPath((b as any).args);
    if (!path) continue;
    const family = EDIT_TOOL_RE.test(b.name) ? "edit" : READ_TOOL_RE.test(b.name) ? "read" : "tool";
    toolFacts.push({ key: `tool:${b.name.toLowerCase()}:${path}`, family });
  }
  return buildFacts({
    filesModified: union(files.modified, files.created),
    filesRead: files.read,
    commits: setOf(formatCommits(extractCommits(blocks), Number.MAX_SAFE_INTEGER)),
    commandFacts, toolFacts,
  });
};

// Same extractor, applied to a rendered brief (both builders parsed identically → symmetric).
const briefRegion = (summary: string): string => {
  const sep = "\n\n---\n\n";
  const start = summary.indexOf(sep);
  let brief = start < 0 ? "" : summary.slice(start + sep.length);
  const note = brief.lastIndexOf("Use `vcc_recall`");
  if (note >= 0) brief = brief.slice(0, note).replace(/\n\n---\n\n\s*$/, "").trimEnd();
  return brief;
};

const parseFilesLine = (line: string, prefix: string): string[] => {
  if (!line.startsWith(`${prefix}: `)) return [];
  return line.slice(prefix.length + 2).split(",").map((s) => s.trim()).filter((s) => s && !/^\(\+\d+ more\)$/.test(s));
};

const factsFromSummary = (summary: string): Facts => {
  const commandFacts: CommandFact[] = [];
  const toolFacts: ToolFact[] = [];
  const modified = new Set<string>();
  const read = new Set<string>();
  const commits = new Set<string>();

  let section = "";
  for (const line of logicalLines(summary)) {
    const header = line.match(/^\[([^\]]+)\]$/)?.[1];
    if (header) { section = header; continue; }
    if (section === "Commits" && line.startsWith("- ")) commits.add(line.slice(2).trim());
    if (section === "Files And Changes" && line.startsWith("- ")) {
      const l = line.slice(2).trim();
      for (const p of [...parseFilesLine(l, "Modified"), ...parseFilesLine(l, "Created")]) modified.add(p);
      for (const p of parseFilesLine(l, "Read")) read.add(p);
    }
  }

  for (const line of logicalLines(briefRegion(summary))) {
    const clean = stripRenderedRef(line.trim());
    const shell = clean.match(/^\$\s+(.+)$/)?.[1];
    if (shell) { const f = commandFact(shell); if (f) commandFacts.push(f); continue; }
    const tool = clean.match(/^\*\s+([^\s"]+)\s*(?:"([\s\S]*)")?/);
    if (!tool) continue;
    const [, name, arg = ""] = tool;
    if (/^bash$/i.test(name)) { const f = commandFact(arg); if (f) commandFacts.push(f); continue; }
    if (!arg || name.startsWith("(")) continue;
    const family = EDIT_TOOL_RE.test(name) ? "edit" : READ_TOOL_RE.test(name) ? "read" : "tool";
    toolFacts.push({ key: `tool:${name.toLowerCase()}:${arg}`, family });
  }

  return buildFacts({ filesModified: modified, filesRead: read, commits, commandFacts, toolFacts });
};

// FileOps feed the ranker the same hook-modified/hook-read signal production has.
const fileOpsFromBlocks = (blocks: NormalizedBlock[]): FileOps => {
  const modified = new Set<string>();
  const read = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== "tool_call" || !b.name) continue;
    const p = extractPath((b as any).args);
    if (!p) continue;
    if (EDIT_TOOL_RE.test(b.name)) modified.add(p);
    else if (READ_TOOL_RE.test(b.name)) read.add(p);
  }
  return { modifiedFiles: [...modified], readFiles: [...read] };
};

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────
const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pp = (x: number): string => (x * 100).toFixed(1);

// ─────────────────────────────────────────────────────────────────────────────
// Session loading
// ─────────────────────────────────────────────────────────────────────────────
const listJsonl = (dir: string): string[] => {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listJsonl(full));
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
};

interface Row {
  sessionId: string;
  baselineChars: number;
  rankedChars: number;
  reductionPct: number;
  baselineRecall: number;
  rankedRecall: number;
  recallDelta: number;
  baselineDensity: number;
  rankedDensity: number;
  baselinePrecision: number;
  rankedPrecision: number;
  baselineCmdDupes: number;
  rankedCmdDupes: number;
}

const rowFor = (file: string): Row | null => {
  const raw = readFileSync(file, "utf8");
  const entries = parseSessionEntries(raw);
  const sessionId = entries.find((e: any) => e.type === "session")?.id ?? file.split("/").pop()!.replace(/\.jsonl$/, "");
  const messages = entries.filter((e: any) => e.type === "message" && e.message).map((e: any) => e.message);
  if (messages.length === 0) return null;

  const llm = convertToLlm(messages);
  const blocks = filterNoise(normalize(llm));
  const ref = factsFromBlocks(blocks);

  const baseline = compile({ messages: llm });
  const ranked = compileRanked({
    messages: llm,
    fileOps: fileOpsFromBlocks(blocks),
    // Production budget path: clamp(perBlock * blockCount, floor, ceiling). See README §5.
    ranking: {
      maxBlocks: MAX_BLOCKS,
      preserveRecentBlocks: RECENT,
      maxBriefChars: FLOOR,
      maxBriefCharsCeiling: CEILING,
      briefCharsPerBlock: PER_BLOCK,
    },
  });

  const bf = factsFromSummary(baseline);
  const rf = factsFromSummary(ranked);
  const bRecall = weightedRecall(ref, bf);
  const rRecall = weightedRecall(ref, rf);
  return {
    sessionId,
    baselineChars: baseline.length,
    rankedChars: ranked.length,
    reductionPct: baseline.length > 0 ? (baseline.length - ranked.length) / baseline.length : 0,
    baselineRecall: bRecall,
    rankedRecall: rRecall,
    recallDelta: rRecall - bRecall,
    baselineDensity: weightedFactDensity(ref, bf, baseline.length),
    rankedDensity: weightedFactDensity(ref, rf, ranked.length),
    baselinePrecision: precision(bf),
    rankedPrecision: precision(rf),
    baselineCmdDupes: bf.commandExactDupes,
    rankedCmdDupes: rf.commandExactDupes,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────
const files = listJsonl(SESSIONS_DIR);
if (files.length === 0) {
  console.error(`No *.jsonl sessions under ${SESSIONS_DIR}. Pass --sessions=DIR.`);
  process.exit(1);
}

const rows: Row[] = [];
for (const file of files) {
  if (rows.length >= LIMIT) break;
  try {
    const row = rowFor(file);
    if (row) rows.push(row);
  } catch (e: any) {
    console.error(`skip ${file}: ${e?.message ?? e}`);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const cols: (keyof Row)[] = [
  "sessionId", "baselineChars", "rankedChars", "reductionPct",
  "baselineRecall", "rankedRecall", "recallDelta",
  "baselineDensity", "rankedDensity", "baselinePrecision", "rankedPrecision",
  "baselineCmdDupes", "rankedCmdDupes",
];
const esc = (v: unknown): string => {
  const s = typeof v === "number" ? String(Number(v.toFixed(4))) : String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
writeFileSync(join(OUT_DIR, "benchmark.json"), JSON.stringify(rows, null, 2));
writeFileSync(join(OUT_DIR, "benchmark.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));

// Paired deltas (per-session ranked − baseline), the honest headline (README §3.4).
const recallDeltas = rows.map((r) => r.recallDelta);
const wins = rows.filter((r) => r.recallDelta > 0.001).length;
const losses = rows.filter((r) => r.recallDelta < -0.001).length;

console.log(`\nsessions scored: ${rows.length}\n`);
console.log("metric                     baseline    ranked     ");
console.log("─────────────────────────  ─────────  ─────────");
console.log(`weightedRecall   (median)  ${pp(median(rows.map((r) => r.baselineRecall))).padStart(7)}%  ${pp(median(rows.map((r) => r.rankedRecall))).padStart(7)}%`);
console.log(`factDensity      (median)  ${median(rows.map((r) => r.baselineDensity)).toFixed(2).padStart(8)}  ${median(rows.map((r) => r.rankedDensity)).toFixed(2).padStart(8)}`);
console.log(`precision        (median)  ${median(rows.map((r) => r.baselinePrecision)).toFixed(2).padStart(8)}  ${median(rows.map((r) => r.rankedPrecision)).toFixed(2).padStart(8)}`);
console.log(`cmd dupes/brief  (mean)    ${mean(rows.map((r) => r.baselineCmdDupes)).toFixed(2).padStart(8)}  ${mean(rows.map((r) => r.rankedCmdDupes)).toFixed(2).padStart(8)}`);
console.log(`brief chars      (median)  ${String(Math.round(median(rows.map((r) => r.baselineChars)))).padStart(8)}  ${String(Math.round(median(rows.map((r) => r.rankedChars)))).padStart(8)}`);
console.log(`\npaired recall delta (ranked − baseline): median ${pp(median(recallDeltas))}pp, mean ${pp(mean(recallDeltas))}pp`);
console.log(`recall wins/losses: ${wins}/${losses}`);
console.log(`size reduction: median ${pp(median(rows.map((r) => r.reductionPct)))}%, mean ${pp(mean(rows.map((r) => r.reductionPct)))}%`);
console.log(`\noutput: ${join(OUT_DIR, "benchmark.csv")}`);
