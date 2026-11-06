// A previous summary that has no stored state (written by pi-vcc, by omp-vcc
// before it stored one, or by another compactor), read from its text once,
// so the next compaction can merge into it like any other. Also what reads a
// section of a summary's text (tests, reports).
import { EARLY_REQUESTS_KEPT } from "../extract/user-messages";
import type { PreviousSummary, SummaryState } from "./summary-state";
import { wrapLongLines } from "./format";
import type { Commit } from "../extract/commits";

// The text older versions wrote, as they wrote it. Frozen here, not read from
// core/format.ts: renaming a section or rewording the note there is a change
// to what is written from now on, and must not stop older summaries being read.
const SEPARATOR = "\n\n---\n\n";
const COMMAND_SEPARATOR = " | ";
const RECALL_NOTE = "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.";
const SECTION = {
  early: "Early Session Requests",
  files: "Files And Changes",
  commits: "Commits",
  tracked: "Tracked Commands",
  userMessages: "User Messages",
} as const;

// A header section is a "[Title Case]" line standing alone in the header area
// (the text before the first separator) plus the lines up to the next blank
// line; sections are joined by blank lines and have none inside. The brief
// transcript's blocks are "[user]" / "[assistant]", and a transcript line can
// start with "[Some Title]" followed by more text, so a header is never found
// by searching the text for "[Title]". Matching the shape, not a list of names,
// also bounds sections written by older versions (e.g. [Outstanding Context]).
const HEADER_LINE_RE = /^\[[A-Z][^\]\n]*\]$/;

/** Header area and brief transcript. Without a leading header line the whole
 * text is the brief; header sections only (no separator) have no brief. */
const splitSummary = (text: string): { head: string; brief: string } => {
  if (!HEADER_LINE_RE.test(text.split("\n", 1)[0])) return { head: "", brief: text.trim() };
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return { head: text, brief: "" };
  return { head: text.slice(0, idx), brief: text.slice(idx + SEPARATOR.length).trim() };
};

/** A named section of a summary's text, its header line included; "" when it has none. */
export const sectionOf = (text: string, header: string): string => {
  const lines = splitSummary(text).head.split("\n");
  const start = lines.indexOf(`[${header}]`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  return lines.slice(start, end).join("\n").trim();
};

/** A summary's brief transcript. */
export const briefOf = (text: string): string => splitSummary(text).brief;

/**
 * The recall note as stored, wrapped across lines (it is longer than the wrap
 * width), with the separator in front of it. Older versions left it inside
 * the brief, and each compaction stacked one more.
 */
const RECALL_NOTE_RE = new RegExp(
  "\\n*(?:---\\n+)?" +
    RECALL_NOTE.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+") +
    "\\n*",
  "g",
);

/** A section's items, each a "- " line with its wrapped continuation rejoined; skill markup an older version wrote is left out. */
const items = (text: string, header: string): string[] =>
  sectionOf(text, header)
    .replace(/\n[ \t]+(?=\S)/g, " ")
    .split("\n")
    .filter((l) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill"))
    .map((l) => l.slice(2));

/** "(+N earlier) a, b" (and an older version's trailing "(+N more)") without the count. */
const withoutCount = (text: string): string =>
  text.replace(/^\s*\(\+\d+ earlier\)\s*/, "").replace(/\s*\(\+\d+ (?:more|earlier)\)\s*$/, "");

/** "Name: a<sep>b" items as name -> entries. */
const listed = (lines: readonly string[], splitOn: string): Array<{ name: string; entries: string[] }> =>
  lines.flatMap((line) => {
    const m = line.match(/^([^:]+): (.*)$/);
    if (!m) return [];
    return [{ name: m[1], entries: withoutCount(m[2]).split(splitOn).map((e) => e.trim()).filter(Boolean) }];
  });

const COMMIT_RE = /^([0-9a-f]{7,12}): (.*)$/;

/**
 * An older summary as state, and the early requests it still has room for.
 * `foreign`: another compactor (an LLM) wrote it, so the session's first
 * requests are long gone and none are taken from the next window. Its brief
 * is wrapped as omp-vcc's own is (format.ts wrapLongLines).
 */
export const legacyPrevious = (summary: string, foreign = false): PreviousSummary => {
  const text = summary.replace(RECALL_NOTE_RE, "\n\n").trimEnd();
  const early = items(text, SECTION.early);
  // An older version's [Session Goal]: its first real line (not a "[skill: x]"
  // or "[Scope change]" marker) is the first request, and the ones after it are
  // long gone, so none are added.
  const goal = early.length === 0 ? items(text, "Session Goal").find((l) => !/^\[[^\]]*\]$/.test(l)) : undefined;
  const earlyRequests = early.length > 0 ? early.slice(0, EARLY_REQUESTS_KEPT) : goal ? [goal] : [];
  const earlySlots = sectionOf(text, SECTION.early) ? EARLY_REQUESTS_KEPT - earlyRequests.length : goal ? 0 : EARLY_REQUESTS_KEPT;
  const files = Object.fromEntries(listed(items(text, SECTION.files), ", ").map((l) => [l.name, l.entries]));
  const commits: Commit[] = items(text, SECTION.commits).map((l) => {
    const m = l.match(COMMIT_RE);
    return m ? { hash: m[1], message: m[2] } : { message: l };
  });
  return {
    state: {
      earlyRequests,
      files: { modified: files.Modified ?? [], created: files.Created ?? [], read: files.Read ?? [] },
      commits,
      tracked: listed(items(text, SECTION.tracked), COMMAND_SEPARATOR),
      userMessages: items(text, SECTION.userMessages),
      brief: wrapLongLines(briefOf(text)),
    },
    earlySlots: foreign ? 0 : Math.max(0, earlySlots),
  };
};

/**
 * An older summary listed absolute paths without the directory they all
 * shared, and its text does not say which: `f3.ts` for `/repo/src/f3.ts`. A
 * listed path that exactly one of this window's absolute paths ends with is
 * that file, so a file touched again is not listed under two names.
 */
export const withFullPaths = (previous: PreviousSummary, fresh: SummaryState): PreviousSummary => {
  const absolute = [...new Set([...fresh.files.modified, ...fresh.files.created, ...fresh.files.read].filter((p) => p.startsWith("/")))];
  const full = (p: string): string => {
    if (p.startsWith("/")) return p;
    const matches = absolute.filter((a) => a.endsWith(`/${p}`));
    return matches.length === 1 ? matches[0] : p;
  };
  const { files } = previous.state;
  return {
    ...previous,
    state: { ...previous.state, files: { modified: files.modified.map(full), created: files.created.map(full), read: files.read.map(full) } },
  };
};
