// A summary's text, rendered from its sections' data (core/summary-state.ts)
// and the sections each compaction builds again (pins, history, working set).
// Nothing reads this text back but core/legacy-summary.ts, for a summary from
// before the state was stored.
import type { SummaryState } from "./summary-state";
import type { SummaryLimits } from "./window";
import { RECALL_TOOL } from "../names";

export const SECTION = {
  pins: "Pinned Notes",
  taskState: "Task State",
  early: "Early Session Requests",
  files: "Files And Changes",
  commits: "Commits",
  tracked: "Tracked Commands",
  userMessages: "User Messages",
  history: "History Index",
  workingSet: "Working Set",
} as const;

/** Between the header sections, the brief and the recall note. */
const SEPARATOR = "\n\n---\n\n";

/** Between a tracked command's invocations: an entry (`kubectl get pods,svc`) can contain a comma. */
const COMMAND_SEPARATOR = " | ";
/** One tracked invocation is clipped to this many characters. */
const TRACKED_ENTRY_CHARS = 80;

const RECALL_NOTE =
  `Use \`${RECALL_TOOL}\` to search for prior work, decisions, and context from before this summary. ` +
  "Do not redo work already completed.";

/**
 * A tracked invocation as one line: a quoted multi-line argument (`python3 -c
 * '...'`) would break the section's line, and a separator inside it is escaped
 * (` \| `) so it reads as one entry. Then clipped.
 */
const trackedEntry = (entry: string): string => {
  const line = entry.replace(/\s+/g, " ").replaceAll(COMMAND_SEPARATOR, " \\| ");
  return line.length > TRACKED_ENTRY_CHARS ? `${line.slice(0, TRACKED_ENTRY_CHARS)}…` : line;
};

/**
 * Join a list's items (oldest first), keeping the newest `limit` behind a
 * leading "(+N earlier)": keeping the oldest froze a merged list on its first
 * entries.
 */
const capItems = (items: readonly string[], limit: number, joinWith: string): string => {
  if (items.length <= limit) return items.join(joinWith);
  return `(+${items.length - limit} earlier) ` + items.slice(-limit).join(joinWith);
};

/**
 * The last `maxLines` lines of a brief, starting at a block's header so no
 * block is cut in the middle, behind a count of the lines left out.
 */
export const capBrief = (text: string, maxLines: number): string => {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${lines.length - clean.length} earlier lines omitted)\n\n${clean.join("\n")}`;
};

const TUI_SAFE_LINE_CHARS = 120;

const wrapLine = (line: string, maxChars: number): string[] => {
  if (line.length <= maxChars) return [line];

  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
  const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
  const wrapped: string[] = [];
  let remaining = line;
  let prefix = "";

  while (prefix.length + remaining.length > maxChars) {
    const available = Math.max(20, maxChars - prefix.length);
    let splitAt = remaining.lastIndexOf(" ", available);
    if (splitAt < Math.floor(available * 0.5)) splitAt = available;

    wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
    prefix = continuationIndent;
  }

  if (remaining) wrapped.push(prefix + remaining);
  return wrapped;
};

/** Lines wrapped for the hosts' TUI, which shows a summary as written. */
export const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
  text.split("\n").flatMap((line) => wrapLine(line, maxChars)).join("\n");

/**
 * The longest directory two or more absolute paths share (at least `/a/b/`),
 * left off when they are listed: it says the same thing on every line.
 */
const commonDir = (paths: readonly string[]): string => {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1 && split.every((s) => s[i] === split[0][i])) i++;
  return i < 2 ? "" : split[0].slice(0, i).join("/") + "/";
};

const section = (title: string, items: readonly string[]): string =>
  items.length === 0 ? "" : `[${title}]\n${items.map((i) => `- ${i}`).join("\n")}`;

const fileLines = (files: SummaryState["files"], limit: number): string[] => {
  const shown = [files.modified, files.created, files.read].flatMap((l) => l.slice(-limit));
  const dir = commonDir(shown);
  const trim = (p: string) => (dir && p.startsWith(dir) ? p.slice(dir.length) : p);
  return ([["Modified", files.modified], ["Created", files.created], ["Read", files.read]] as const)
    .filter(([, list]) => list.length > 0)
    .map(([label, list]) => `${label}: ${capItems(list.map(trim), limit, ", ")}`);
};

interface RenderInput {
  state: SummaryState;
  limits: SummaryLimits;
  /** [Pinned Notes] lines (core/pins.ts formatPinLines). */
  pins?: readonly string[];
  /** [History Index] lines (core/history-index.ts formatHistoryRange). */
  history?: readonly string[];
  /** [Working Set] lines (core/working-set.ts formatWorkingSet): file excerpts, shown as they are. */
  workingSet?: readonly string[];
  /** [Task State] lines (core/task-state.ts): where the work stands. */
  taskState?: readonly string[];
}

/**
 * The summary: [Pinned Notes] first (the start of the context is where a model
 * attends best, arXiv:2307.03172), then [Task State], the carried sections, [History Index] and
 * [Working Set] last in the header, next to the brief and the kept turns; then
 * the brief and the recall note. Empty when there is nothing to show.
 */
export const renderSummary = (input: RenderInput): { text: string; sections: string[] } => {
  const { state, limits } = input;
  const parts: Array<[string, string]> = [
    [SECTION.pins, section(SECTION.pins, input.pins ?? [])],
    [SECTION.taskState, section(SECTION.taskState, input.taskState ?? [])],
    [SECTION.early, section(SECTION.early, state.earlyRequests)],
    [SECTION.files, section(SECTION.files, fileLines(state.files, limits.filesPerCategory))],
    [SECTION.commits, section(SECTION.commits, state.commits.slice(-limits.commits).map((c) => (c.hash ? `${c.hash}: ${c.message}` : c.message)))],
    [SECTION.tracked, section(SECTION.tracked, state.tracked.map((t) => `${t.name}: ${capItems(t.entries.map(trackedEntry), limits.commandsPerName, COMMAND_SEPARATOR)}`))],
    [SECTION.userMessages, section(SECTION.userMessages, state.userMessages.slice(-limits.userMessages))],
    [SECTION.history, section(SECTION.history, input.history ?? [])],
  ];
  const shown = parts.filter(([, text]) => text);
  const workingSet = input.workingSet && input.workingSet.length > 0 ? `[${SECTION.workingSet}]\n${input.workingSet.join("\n")}` : "";
  const head = [wrapLongLines(shown.map(([, text]) => text).join("\n\n")), workingSet].filter(Boolean).join("\n\n");
  if (!head && !state.brief) return { text: "", sections: [] };
  const body = [head, state.brief].filter(Boolean).join(SEPARATOR);
  return {
    text: `${body}${SEPARATOR}${wrapLongLines(RECALL_NOTE)}`,
    sections: [...shown.map(([name]) => name), ...(workingSet ? [SECTION.workingSet] : [])],
  };
};
