import { renderedOf, searchHits } from "./pairs";
import type { Message } from "@oh-my-pi/pi-ai";
// A before/after report of one compile over a session's messages, for the
// real-session tests and the benchmark scripts, at a ~128K window's limits.
import { type CompileInput, type CompiledSummary, compileSummary } from "./compile";
import { DEFAULT_SUMMARY_LIMITS } from "./window";

/** Tokens at the heuristic ~4 chars each, rounded up. */
const estimateTokensFromChars = (chars: number): number => Math.ceil(chars / 4);
const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));
import { briefOf } from "./summary";

/** The header sections the report counts (the brief is not one). */
const SECTION_HEADERS = ["Early Session Requests", "Files And Changes", "Commits", "Tracked Commands", "User Messages"];

interface RoleCounts {
  user: number;
  assistant: number;
  toolResult: number;
}

interface BlockCounts {
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
}

export interface RecallProbe {
  label: string;
  sourceText: string;
  query: string;
  summaryMentioned: boolean;
  recallHits: number;
}

export interface CompactReport {
  summary: string;
  before: {
    messageCount: number;
    roleCounts: RoleCounts;
    blockCounts: BlockCounts;
    inputChars: number;
    estimatedTokens: number;
    topFiles: string[];
    preview: string;
  };
  after: {
    summaryLength: number;
    estimatedTokens: number;
    sectionCount: number;
    summaryPreview: string;
    earlyRequestsCount: number;
    briefTranscriptLines: number;
  };
  compression: {
    charsBefore: number;
    charsAfter: number;
    ratio: number;
    messagesBefore: number;
  };
  recall: {
    probes: RecallProbe[];
  };
}

const countRoles = (messages: Message[]): RoleCounts => {
  const counts: RoleCounts = { user: 0, assistant: 0, toolResult: 0 };
  for (const msg of messages) {
    if (msg.role === "user") counts.user += 1;
    else if (msg.role === "assistant") counts.assistant += 1;
    else if (msg.role === "toolResult") counts.toolResult += 1;
  }
  return counts;
};

/** The summary's units in these messages: user messages, assistant texts, tool calls, tool results. */
const countBlocks = (messages: Message[]): BlockCounts => {
  const counts: BlockCounts = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0 };
  for (const msg of messages as any[]) {
    if (msg.role === "user") counts.user += 1;
    else if (msg.role === "toolResult") counts.toolResults += 1;
    else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && part.text?.trim()) counts.assistant += 1;
        else if (part?.type === "toolCall") counts.toolCalls += 1;
      }
    }
  }
  return counts;
};

/** Chars of every message as recall's full view renders it. */
const inputCharsOf = (messages: Message[]): number =>
  renderedOf(messages).reduce((sum, e) => sum + e.text.length, 0);

/** The files the summary lists: changed first, then read. */
const filesOf = (compiled: CompiledSummary): string[] => {
  const { modified, created, read } = compiled.state.files;
  return [...new Set([...modified, ...created, ...read])];
};

const previewOf = (messages: Message[], edgeCount = 3): string => {
  const rendered = renderedOf(messages);
  if (rendered.length === 0) return "(empty)";
  if (rendered.length <= edgeCount * 2) {
    return rendered
      .map((entry) => `#${entry.index} [${entry.role}] ${clip(entry.summary, 220)}`)
      .join("\n");
  }

  const first = rendered.slice(0, edgeCount);
  const last = rendered.slice(-edgeCount);
  return [
    ...first.map((entry) => `#${entry.index} [${entry.role}] ${clip(entry.summary, 220)}`),
    "...",
    ...last.map((entry) => `#${entry.index} [${entry.role}] ${clip(entry.summary, 220)}`),
  ].join("\n");
};

const sectionCountOf = (compiled: CompiledSummary): number =>
  SECTION_HEADERS.filter((header) => compiled.sections.includes(header)).length;

const briefLineCountOf = (summary: string): number => {
  const brief = briefOf(summary);
  return brief ? brief.split("\n").length : 0;
};

const queryTermsOf = (text: string): string[] =>
  (text.match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [])
    .map((part) => part.trim())
    .filter(Boolean);

const queryOf = (text: string): string => {
  const terms = queryTermsOf(text);
  return terms.slice(0, 6).join(" ");
};

const matchesQuery = (text: string, query: string): boolean => {
  const hay = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
};

const probesOf = (messages: Message[], compiled: CompiledSummary): RecallProbe[] => {
  const summary = compiled.text;
  const rawProbes = [
    { label: "request", text: compiled.state.earlyRequests[0] ?? "" },
    { label: "file", text: filesOf(compiled)[0] ?? "" },
  ];

  return rawProbes
    .map(({ label, text }) => {
      const sourceText = text.trim();
      const query = queryOf(sourceText);
      if (!query) return null;
      return {
        label,
        sourceText,
        query,
        summaryMentioned: matchesQuery(summary, query),
        recallHits: searchHits(messages, query).length,
      };
    })
    .filter((probe): probe is RecallProbe => probe !== null);
};

export const buildCompactReport = (input: Omit<CompileInput, "limits">): CompactReport => {
  const compiled = compileSummary({ limits: DEFAULT_SUMMARY_LIMITS, ...input });
  const summary = compiled.text;
  const inputChars = inputCharsOf(input.messages);
  const topFiles = filesOf(compiled).slice(0, 10);

  return {
    summary,
    before: {
      messageCount: input.messages.length,
      roleCounts: countRoles(input.messages),
      blockCounts: countBlocks(input.messages),
      inputChars,
      estimatedTokens: estimateTokensFromChars(inputChars),
      topFiles,
      preview: previewOf(input.messages),
    },
    after: {
      summaryLength: summary.length,
      estimatedTokens: estimateTokensFromChars(summary.length),
      sectionCount: sectionCountOf(compiled),
      summaryPreview: summary,
      earlyRequestsCount: compiled.state.earlyRequests.length,
      briefTranscriptLines: briefLineCountOf(summary),
    },
    compression: {
      charsBefore: inputChars,
      charsAfter: summary.length,
      ratio: summary.length === 0 ? 0 : Number((inputChars / summary.length).toFixed(2)),
      messagesBefore: input.messages.length,
    },
    recall: {
      probes: probesOf(input.messages, compiled),
    },
  };
};
