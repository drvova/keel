// [History Index]: where things are in the compacted history.
//
// The summary's other sections keep the newest few files, commits and user
// messages, so on a long task older work leaves the summary for good. The raw
// history still has it (vcc_recall), but an agent cannot look up what it does
// not know is there. The index keeps one line per compacted range of `#N`
// entries: how many user requests it held, the longest of them, the files it
// changed, its commits and failed calls. That gives the agent ranges to read and
// words to search for, however far back the work was.
//
// It stays bounded: past MAX_RANGES lines, the two adjacent ranges that span
// the fewest entries merge. Recent ranges stay fine and old ones coarsen, about
// geometrically. Each range is built from the messages, never from summary text,
// and is stored in the compaction's details, so it is not re-parsed or reworded
// across compactions. Nothing depends on wording: it works in every language.
import type { Message } from "@oh-my-pi/pi-ai";
import type { NormalizedBlock } from "../types";
import { clip } from "./content";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { vccDetailsOf } from "../details";
import { extractFiles } from "../extract/files";
import { extractCommits } from "../extract/commits";
import { extractUserMessages } from "../extract/user-messages";
import { DEFAULT_SUMMARY_LIMITS } from "./window";

export interface HistoryRange {
  /** First and last session-wide `#N` the range covers. */
  from: number;
  to: number;
  /** User requests in the range; undefined for a range from before the index existed. */
  requests?: number;
  /** The longest user requests, as written (clipped), longest first. */
  asks: string[];
  /** Files changed (modified or created), first seen first. */
  files: string[];
  /** "hash subject" (or the subject alone), oldest first. */
  commits: string[];
  /** Commits in the range, including ones beyond `commits`. */
  commitCount: number;
  /** Tool calls whose result was an error. */
  failed: number;
}

/** Lines on a ~128K window; core/window.ts scales it with the model's window. */
export const MAX_RANGES = DEFAULT_SUMMARY_LIMITS.historyRanges;
const ASKS_KEPT = 4;
const ASKS_SHOWN = 1;
const ASK_CHARS = 80;
const FILES_KEPT = 24;
/** Up to this many files are named; a range with more lists the directories it touched. */
const FILES_SHOWN = 3;
const DIRS_SHOWN = 6;
const COMMITS_KEPT = 4;
const COMMIT_CHARS = 45;

const longestFirst = (asks: string[]): string[] =>
  [...new Set(asks)].sort((a, b) => b.length - a.length).slice(0, ASKS_KEPT);

/** The range this compaction summarizes, or undefined when it has no `#N` refs. */
export const rangeOfWindow = (
  messages: Message[],
  sourceIndices: Array<number | undefined>,
): HistoryRange | undefined => {
  const known = sourceIndices.filter((n): n is number => typeof n === "number");
  if (known.length === 0) return undefined;
  const blocks: NormalizedBlock[] = filterNoise(normalize(messages, sourceIndices));
  const files = extractFiles(blocks);
  const changed = [...new Set([...files.modified, ...files.created])];
  const commits = extractCommits(blocks).map((c) => clip(c.hash ? `${c.hash} ${c.message}` : c.message, COMMIT_CHARS));
  const asks = extractUserMessages(blocks);
  return {
    from: Math.min(...known),
    to: Math.max(...known),
    requests: asks.length,
    // Ranked by full length, then clipped: clipped first, every long request ties at ASK_CHARS.
    asks: longestFirst(asks).map((a) => clip(a, ASK_CHARS)),
    files: changed.slice(0, FILES_KEPT),
    commits: commits.slice(-COMMITS_KEPT),
    commitCount: commits.length,
    failed: blocks.filter((b) => b.kind === "tool_call" && b.failed).length,
  };
};

const mergeTwo = (a: HistoryRange, b: HistoryRange): HistoryRange => ({
  from: Math.min(a.from, b.from),
  to: Math.max(a.to, b.to),
  requests: a.requests == null || b.requests == null ? undefined : a.requests + b.requests,
  asks: longestFirst([...a.asks, ...b.asks]),
  files: [...new Set([...a.files, ...b.files])].slice(0, FILES_KEPT),
  commits: [...a.commits, ...b.commits].slice(-COMMITS_KEPT),
  commitCount: a.commitCount + b.commitCount,
  failed: a.failed + b.failed,
});

/** A range with nothing to name: no request, file, commit or failed call. */
const saysNothing = (r: HistoryRange): boolean =>
  r.requests === 0 && r.files.length === 0 && r.commitCount === 0 && r.failed === 0;

/**
 * Add this compaction's range and coarsen back to `maxRanges`. The newest range
 * never merges, so the work just summarized stays on a line of its own, unless
 * it has nothing to name (say the previous turn's final reply, kept by the last
 * compaction): then it is the end of the range before it, not a line of its own.
 */
export const mergeHistoryIndex = (previous: HistoryRange[], fresh: HistoryRange | undefined, maxRanges = MAX_RANGES): HistoryRange[] => {
  const ranges = [...previous];
  const last = ranges[ranges.length - 1];
  if (fresh && last && saysNothing(fresh) && fresh.from <= last.to + 1 && fresh.to > last.to) {
    ranges[ranges.length - 1] = { ...last, to: fresh.to };
    return ranges;
  }
  if (fresh) ranges.push(fresh);
  ranges.sort((a, b) => a.from - b.from);
  while (ranges.length > Math.max(2, maxRanges)) {
    let best = 0;
    let bestSpan = Infinity;
    for (let i = 0; i < ranges.length - 2; i++) {
      const span = ranges[i + 1].to - ranges[i].from;
      if (span < bestSpan) {
        best = i;
        bestSpan = span;
      }
    }
    ranges.splice(best, 2, mergeTwo(ranges[best], ranges[best + 1]));
  }
  return ranges;
};

/** A range for the history before the first indexed compaction, so the index still covers it. */
export const unindexedRange = (to: number): HistoryRange => ({ from: 0, to, asks: [], files: [], commits: [], commitCount: 0, failed: 0 });

const shortPath = (path: string): string => path.split("/").slice(-2).join("/");

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The directory a file is in, as its last segment ("src/auth/client.ts" -> "auth"); "." for a bare name. */
const dirOf = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : ".";
};

const formatFiles = (files: string[]): string => {
  if (files.length <= FILES_SHOWN) return `changed ${files.map(shortPath).join(", ")}`;
  const dirs = [...new Set(files.map(dirOf))];
  const count = files.length >= FILES_KEPT ? `${files.length}+` : String(files.length);
  const more = dirs.length > DIRS_SHOWN ? ", …" : "";
  return `changed ${count} files in ${dirs.slice(0, DIRS_SHOWN).join(", ")}${more}`;
};

export const formatHistoryRange = (r: HistoryRange): string => {
  const parts: string[] = [];
  if (r.requests == null) parts.push("earlier, not indexed; search it with vcc_recall");
  else if (r.requests > 0) parts.push(`${plural(r.requests, "request")}: ${r.asks.slice(0, ASKS_SHOWN).map((a) => `"${a}"`).join(", ")}`);
  if (r.files.length > 0) parts.push(formatFiles(r.files));
  if (r.commitCount > 0) {
    const last = r.commits[r.commits.length - 1];
    parts.push(r.commitCount === 1 ? `1 commit: ${last}` : `${r.commitCount} commits, last ${last}`);
  }
  if (r.failed > 0) parts.push(plural(r.failed, "failed call"));
  return `#${r.from}–#${r.to}${parts.length > 0 ? `: ${parts.join(" · ")}` : ""}`;
};

const isRange = (value: unknown): value is HistoryRange => {
  const r = value as HistoryRange;
  return !!r && Number.isInteger(r.from) && Number.isInteger(r.to) && r.from <= r.to
    && Array.isArray(r.asks) && Array.isArray(r.files) && Array.isArray(r.commits)
    && Number.isInteger(r.commitCount) && Number.isInteger(r.failed)
    && (r.requests === undefined || Number.isInteger(r.requests));
};

/** The index an omp-vcc (or, before the rename, pi-vcc) compaction stored in its details, if it is well-formed. */
export const readHistoryIndex = (details: unknown): HistoryRange[] | undefined => {
  const index: unknown = vccDetailsOf(details)?.historyIndex;
  if (!Array.isArray(index)) return undefined;
  return index.every(isRange) ? (index as HistoryRange[]) : undefined;
};
