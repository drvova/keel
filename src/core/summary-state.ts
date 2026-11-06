// The sections a summary carries from one compaction to the next, as data.
//
// Each compaction stores what its summary shows of them in its details, and
// the next one merges this window's into that, item by item, and renders the
// summary from the result (core/format.ts). Nothing is read back from the
// summary's text: a summary from before (pi-vcc, or omp-vcc before the state
// was stored) is read once into this shape by core/legacy-summary.ts.
// [Pinned Notes], [History Index] and [Working Set] are not carried here: each
// compaction builds them again.
import type { FileOps, NormalizedBlock } from "../types";
import { extractFiles } from "../extract/files";
import { EARLY_REQUESTS_KEPT, extractUserMessages } from "../extract/user-messages";
import { addCommit, extractCommits, type Commit } from "../extract/commits";
import { extractTrackedCommands } from "../extract/tracked-commands";
import { buildBriefSections, stringifyBrief } from "./brief";
import { capBrief, wrapLongLines } from "./format";
import type { SummaryLimits } from "./window";
import { isObject } from "./content";

export interface SummaryState {
  /** The session's first requests, set by the first compactions and kept as they are. */
  earlyRequests: string[];
  /** Paths as the calls gave them, oldest first; a file worked on again moves to the end. */
  files: { modified: string[]; created: string[]; read: string[] };
  commits: Commit[];
  /** Per tracked command name, its invocations as one line each, oldest first. */
  tracked: Array<{ name: string; entries: string[] }>;
  userMessages: string[];
  /** The brief transcript as shown, its lines wrapped. */
  brief: string;
}

/** A previous summary to merge into: its state, and how many early requests it still has room for. */
export interface PreviousSummary {
  state: SummaryState;
  earlySlots: number;
}

export const previousOf = (state: SummaryState): PreviousSummary => ({
  state,
  earlySlots: Math.max(0, EARLY_REQUESTS_KEPT - state.earlyRequests.length),
});

interface FreshInput {
  blocks: NormalizedBlock[];
  /** The blocks the brief covers (the ranked selection); all of them when omitted. */
  briefBlocks?: NormalizedBlock[];
  /** The host's file activity for the window, authoritative for what the blocks do not show. */
  fileOps?: FileOps;
  trackCommands?: readonly string[];
  /** Early requests this window may add: the previous summary's room, all of it without one. */
  earlySlots: number;
}

/** This window's sections. Lists are whole; capState and the render cap them. */
export const freshState = (input: FreshInput): SummaryState => {
  const { blocks } = input;
  // The early requests are the session's first user messages, picked by
  // position; they are not repeated in [User Messages].
  const messages = extractUserMessages(blocks);
  const early = messages.slice(0, Math.max(0, input.earlySlots));
  const files = extractFiles(blocks, input.fileOps);
  const tracked = extractTrackedCommands(blocks, input.trackCommands ?? []);
  const brief = stringifyBrief(buildBriefSections(input.briefBlocks ?? blocks));
  return {
    earlyRequests: early,
    files: { modified: [...files.modified], created: [...files.created], read: [...files.read] },
    commits: extractCommits(blocks),
    tracked: [...tracked.byCommand]
      .filter(([, entries]) => entries.size > 0)
      // Whole: two invocations sharing a prefix are two entries; the summary clips what it shows.
      .map(([name, entries]) => ({ name, entries: [...entries] })),
    userMessages: messages.slice(early.length),
    // Sized by the ranked selection's budget, not by lines.
    brief: wrapLongLines(brief),
  };
};

/** `items` and then `more`, a repeated item moved to the end. */
const appendTouched = (items: readonly string[], more: readonly string[]): string[] => {
  const out = [...items];
  for (const item of more) {
    const at = out.indexOf(item);
    if (at >= 0) out.splice(at, 1);
    out.push(item);
  }
  return out;
};

const mergeCommits = (commits: readonly Commit[]): Commit[] => {
  const out: Commit[] = [];
  for (const c of commits) addCommit(out, c);
  return out;
};

/** Brief lines: the fresh brief whole, and as much of the previous one's end as the line limit leaves. */
const mergeBrief = (prev: string, fresh: string, maxLines: number): string => {
  if (!prev) return fresh;
  if (!fresh) return capBrief(prev, maxLines);
  const room = maxLines - fresh.split("\n").length;
  const tail = room > 0 ? capBrief(prev, room) : "";
  return tail ? `${tail}\n\n${fresh}` : fresh;
};

/** The previous summary's sections with this window's merged in. */
export const mergeStates = (previous: PreviousSummary | undefined, fresh: SummaryState, limits: SummaryLimits): SummaryState => {
  if (!previous) return fresh;
  const prev = previous.state;
  const modified = appendTouched(prev.files.modified, fresh.files.modified);
  const created = appendTouched(prev.files.created, fresh.files.created);
  // A file in both: created earlier in the session and changed since, it is
  // still new (Created); changed before a later write, it existed (Modified).
  const createdBefore = new Set(prev.files.created);
  for (const p of modified.filter((p) => created.includes(p))) {
    if (createdBefore.has(p)) modified.splice(modified.indexOf(p), 1);
    else created.splice(created.indexOf(p), 1);
  }
  const tracked = prev.tracked.map((t) => ({ name: t.name, entries: [...t.entries] }));
  for (const t of fresh.tracked) {
    const at = tracked.find((x) => x.name === t.name);
    if (at) at.entries = appendTouched(at.entries, t.entries);
    else tracked.push({ name: t.name, entries: [...t.entries] });
  }
  return {
    earlyRequests: [...new Set([...prev.earlyRequests, ...fresh.earlyRequests])].slice(0, EARLY_REQUESTS_KEPT),
    files: { modified, created, read: appendTouched(prev.files.read, fresh.files.read) },
    commits: mergeCommits([...prev.commits, ...fresh.commits]),
    tracked,
    userMessages: appendTouched(prev.userMessages, fresh.userMessages),
    brief: mergeBrief(prev.brief, fresh.brief, limits.briefLines),
  };
};

/** What a summary shows of each list, which is what it stores for the next compaction. */
export const capState = (state: SummaryState, limits: SummaryLimits): SummaryState => ({
  earlyRequests: state.earlyRequests.slice(0, EARLY_REQUESTS_KEPT),
  files: {
    modified: state.files.modified.slice(-limits.filesPerCategory),
    created: state.files.created.slice(-limits.filesPerCategory),
    read: state.files.read.slice(-limits.filesPerCategory),
  },
  commits: state.commits.slice(-limits.commits),
  tracked: state.tracked.map((t) => ({ name: t.name, entries: t.entries.slice(-limits.commandsPerName) })),
  userMessages: state.userMessages.slice(-limits.userMessages),
  brief: state.brief,
});

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A field a stored state may lack (written before it existed): read as `empty`. Present in another shape, it is not a state. */
const field = <T>(v: unknown, is: (x: unknown) => x is T, empty: T): T | undefined => (v === undefined ? empty : is(v) ? v : undefined);
const isCommit = (c: unknown): c is Commit => isObject(c) && typeof c.message === "string" && (c.hash === undefined || typeof c.hash === "string");
const isTracked = (t: unknown): t is SummaryState["tracked"][number] => isObject(t) && typeof t.name === "string" && strings(t.entries);
const listOf = <T>(is: (x: unknown) => x is T) => (v: unknown): v is T[] => Array.isArray(v) && v.every(is);
const isText = (v: unknown): v is string => typeof v === "string";

/**
 * A stored state, or undefined when `v` is not one (another version's shape,
 * a hand-edited file). Built field by field: a section added later is read
 * here or the build fails, and a state stored before it existed loads with
 * it empty.
 */
export const readState = (v: unknown): SummaryState | undefined => {
  if (!isObject(v)) return undefined;
  const files = v.files === undefined ? {} : isObject(v.files) ? v.files : undefined;
  if (!files) return undefined;
  const earlyRequests = field(v.earlyRequests, strings, []);
  const modified = field(files.modified, strings, []);
  const created = field(files.created, strings, []);
  const read = field(files.read, strings, []);
  const commits = field(v.commits, listOf(isCommit), []);
  const tracked = field(v.tracked, listOf(isTracked), []);
  const userMessages = field(v.userMessages, strings, []);
  const brief = field(v.brief, isText, "");
  if (!earlyRequests || !modified || !created || !read || !commits || !tracked || !userMessages || brief === undefined) return undefined;
  return { earlyRequests, files: { modified, created, read }, commits, tracked, userMessages, brief };
};
