import { pairs } from "./pairs";
import type { Message } from "@oh-my-pi/pi-ai";
// A before/after report of one compile over a session's messages, for the
// real-session tests and the benchmark scripts, at a ~128K window's limits.
import { clip } from "../../src/core/content";
import { filesOf } from "../../src/core/tools";
import { normalize } from "../../src/core/normalize";
import { renderMessage } from "../../src/core/render-entries";
import { searchEntries } from "../../src/core/search-entries";
import { type CompileInput, compile } from "../../src/core/summarize";
import { briefOf, sectionOf } from "../../src/core/legacy-summary";
import { freshState } from "../../src/core/summary-state";
import { SECTION } from "../../src/core/format";
import { DEFAULT_SUMMARY_LIMITS } from "../../src/core/window";
import { EARLY_REQUESTS_KEPT } from "../../src/extract/user-messages";
import { estimateTokensFromChars } from "../../src/core/token-estimate";

const SECTION_HEADERS = [SECTION.early, SECTION.files, SECTION.commits, SECTION.tracked, SECTION.userMessages];
const earlyRequestsOf = (messages: Message[]): string[] =>
  freshState({ blocks: normalize(messages), earlySlots: EARLY_REQUESTS_KEPT }).earlyRequests;

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

const countBlocks = (messages: Message[]): BlockCounts => {
  const counts: BlockCounts = {
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
  };

  for (const block of normalize(messages)) {
    if (block.kind === "user") counts.user += 1;
    else if (block.kind === "assistant") counts.assistant += 1;
    else if (block.kind === "tool_call") counts.toolCalls += 1;
    else if (block.kind === "tool_result") counts.toolResults += 1;
  }

  return counts;
};

const inputCharsOf = (messages: Message[]): number =>
  messages
    .map((msg, index) => renderMessage(msg, index, true).summary.length)
    .reduce((sum, len) => sum + len, 0);

const topFilesOf = (messages: Message[]): string[] => {
  const files = new Set<string>();
  for (const block of normalize(messages)) {
    if (block.kind === "tool_call") for (const file of filesOf(block)) files.add(file);
  }
  return [...files].slice(0, 10);
};

const previewOf = (messages: Message[], edgeCount = 3): string => {
  const rendered = messages.map((msg, index) => renderMessage(msg, index));
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

const sectionCountOf = (summary: string): number =>
  SECTION_HEADERS.filter((header) => sectionOf(summary, header) !== "").length;

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

const probesOf = (messages: Message[], summary: string): RecallProbe[] => {
  const blocks = normalize(messages);

  // Find first file from tool calls
  const firstFile = blocks.flatMap((b) => (b.kind === "tool_call" ? filesOf(b) : []))[0] ?? "";

  const rawProbes = [
    { label: "request", text: earlyRequestsOf(messages)[0] ?? "" },
    { label: "file", text: firstFile },
  ];

  const rendered = messages.map((msg, index) => renderMessage(msg, index));

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
        recallHits: searchEntries(pairs(rendered, messages), query).length,
      };
    })
    .filter((probe): probe is RecallProbe => probe !== null);
};

export const buildCompactReport = (input: Omit<CompileInput, "limits">): CompactReport => {
  const summary = compile({ limits: DEFAULT_SUMMARY_LIMITS, ...input });
  const inputChars = inputCharsOf(input.messages);
  const topFiles = topFilesOf(input.messages);

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
      sectionCount: sectionCountOf(summary),
      summaryPreview: summary,
      earlyRequestsCount: earlyRequestsOf(input.messages).length,
      briefTranscriptLines: briefLineCountOf(summary),
    },
    compression: {
      charsBefore: inputChars,
      charsAfter: summary.length,
      ratio: summary.length === 0 ? 0 : Number((inputChars / summary.length).toFixed(2)),
      messagesBefore: input.messages.length,
    },
    recall: {
      probes: probesOf(input.messages, summary),
    },
  };
};
