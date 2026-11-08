// A compaction's summary, alone, for the tests and scripts that drive it: this
// window's sections, merged into the state the previous compaction stored (or
// read from an older summary's text), and rendered. The core compiles it
// (lisp/src/summary.lisp, op summarize); these are the shapes it takes and
// gives, which a compaction's details store.
import type { Message } from "@oh-my-pi/pi-ai";
import type { SummaryLimits } from "./window-shapes";
import { core } from "../../src/core";

/** What the host says the summarized turns did to files (its preparation.fileOps). */
export interface FileOps {
  read?: string[];
  /** Edited or written whole; whether a file is new, the blocks tell. */
  changed?: string[];
}

/** A message as the summary reads it (lisp/src/blocks.lisp), which tests hand op summarize as messages' blocks. */
export type NormalizedBlock =
  // `injected`: the text came from an extension custom_message, not from the
  // user. It renders in the brief but is not read into [Early Session Requests]
  // or [User Messages].
  | { kind: "user"; text: string; sourceIndex?: number; injected?: boolean }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  // `failed`: the call's result came back as an error (toolResult isError).
  | { kind: "tool_call"; id?: string; name: string; args: Record<string, unknown>; sourceIndex?: number; failed?: true }
  // `callId`: the id of the call this is the result of.
  | { kind: "tool_result"; callId?: string; name: string; text: string; sourceIndex?: number }
  // A command the user ran themselves: `!cmd`, or (lang "python") a python cell.
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number; lang?: "python" };

export interface PinnedNote {
  id: number;
  text: string;
  by: "user" | "agent";
  /** Session-wide #N of the last message when the note was pinned. */
  at?: number;
}

/** A commit the summary lists: its hash when git printed one, and its subject. */
export interface Commit {
  hash?: string;
  message: string;
}

/** What a summary shows of its carried sections, stored in details.summaryState for the next compaction to merge into. */
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
  /** How many more of the session's first requests a later window may add. */
  earlySlots: number;
}

/** One [History Index] range of compacted `#N`, stored in details.historyIndex. */
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

export interface CompileInput {
  messages: Message[];
  /** The state the previous compaction stored; when absent, `previousSummary` is read from its text. */
  previous?: SummaryState;
  /** The previous summary's text: one an older version or another compactor wrote. */
  previousSummary?: string;
  /** Another compactor (an LLM) wrote `previousSummary`, not keel or pi-vcc. */
  previousSummaryForeign?: boolean;
  fileOps?: FileOps;
  /** Session-global `#N` per message position; a missing one renders as no ref. Omitted, positions are the refs. */
  sourceIndices?: Array<number | undefined>;
  /** Command names for [Tracked Commands] (KeelSettings.trackCommands); none by default. */
  trackCommands?: readonly string[];
  /** The history index to show, already merged with the previous one. */
  historyIndex?: readonly HistoryRange[];
  /** The pinned notes. */
  pinnedNotes?: readonly PinnedNote[];
  /** [Working Set] lines. */
  workingSet?: readonly string[];
  /** [Task State] lines. */
  taskState?: readonly string[];
  /** How many items each section keeps (they follow the model's window). */
  limits: SummaryLimits;
  /** The brief's size: its floor and ceiling in chars, what each block it covers adds between them, and the most blocks. */
  ranking?: { maxBriefChars?: number; maxBriefCharsCeiling?: number; briefCharsPerBlock?: number; maxBlocks?: number; preserveRecentBlocks?: number };
}

export interface CompiledSummary {
  text: string;
  /** What the summary shows of its carried sections, stored for the next compaction to merge into. */
  state: SummaryState;
  /** The sections it shows, in order. */
  sections: string[];
}

/** The summary, and what to store for the next compaction. */
export const compileSummary = (input: CompileInput): CompiledSummary => {
  const reply = core({ op: "summarize", input });
  return { text: reply.text as string, state: reply.state as SummaryState, sections: reply.sections as string[] };
};

/** The summary's text alone, for scripts and tests that read only it. */
export const compile = (input: CompileInput): string => compileSummary(input).text;
