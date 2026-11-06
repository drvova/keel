// vcc_recall: the text the agent reads, its JSON Schema, and what a call does.
//
// omp validates arguments before any extension code runs and has no
// prepareArguments hook, so the schema also accepts the loose forms
// normalizeToolParams repairs (an index as "#12", a range as "10-20", a scope
// value in mode, enum values in another case); executeRecall then normalizes
// them. omp drops unknown keys itself, before execute().
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Binding } from "../host";
import { normalizeToolParams, parseToolRequest, RECALL_PARAMS, type RecallToolParams } from "../core/recall-request";
import { RANGE_PAGE_SIZE, RECALL_OUTPUT_CHARS, recall, SEARCH_PAGE_SIZE, type RecallInput, type RecallPagingHints } from "../core/recall-run";
import { SESSION_REF_MIN_CHARS } from "../core/sessions";
import { RECALL_TOOL } from "../names";

const RECALL_TOOL_LABEL = "VCC Recall";

const RECALL_TOOL_DESCRIPTION = [
  "Recall earlier parts of this session, including anything dropped by compaction.",
  "Use it before saying the context is gone.",
  "",
  "Pick one per call:",
  `- query: keyword search (regex works), ${SEARCH_PAGE_SIZE} results per page.`,
  `- range: [from, to]: entries #from..#to in order, ${RANGE_PAGE_SIZE} per page.`,
  "- expand: [N, ...]: full text of those entries.",
  "- mode: 'touched': files worked on, with entry indices.",
  "- mode: 'sessions': this project's earlier sessions (restarts, /new, forks, handoffs).",
  "- query '#N:path': file content from entry N ('#N:path:full' for all lines).",
  "",
  "Add to any of them:",
  "- page: next page of query, range, touched or sessions results.",
  "- scope: 'lineage' (default) reads the current conversation path; 'all' also",
  "  reads edited or retried branches; 'project' makes a query search this",
  "  project's earlier sessions too.",
  "- session: an earlier session's id (from mode:'sessions' or a [session id] hit):",
  "  the call reads that session; its #N are its own.",
  "",
  "#N is the number shown in summary refs like (#12) and in recall results.",
  `One result is capped at ${Math.round(RECALL_OUTPUT_CHARS / 1024)} KB (less on a small context window).`,
].join("\n");

const RECALL_PARAM_DESCRIPTIONS: Record<(typeof RECALL_PARAMS)[number], string> = {
  query: "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. '#N:path' instead shows a file's content from entry N.",
  range: `[from, to]: every entry from #from to #to (inclusive) in order, ${RANGE_PAGE_SIZE} per page. #N is the number in summary refs like (#12) and in recall results.`,
  expand: "#N indices to return full content for (from summary refs like (#12) or recall results).",
  page: "Page number (1-based) for query, range, touched or sessions results. Default: 1.",
  scope: "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried. 'project' makes a query also search this project's earlier sessions.",
  mode: "hybrid (default) = normal recall; touched = files worked on, by path, with entry indices (misses files written by shell commands); sessions = this project's earlier sessions, newest first.",
  session: `Id (or its first ${SESSION_REF_MIN_CHARS}+ characters) of an earlier session from mode:'sessions' or a [session id] hit: the call reads that session instead of this one.`,
};

/** Follow-up hints in the tool's own params; inside an earlier session they carry session:'id'. */
const toolHints = (short?: string): RecallPagingHints => {
  const at = short ? ` with session:'${short}'` : "";
  return {
    outOfRange: (_query, _scope, totalPages, truncated) => truncated
      ? `Use a page between 1 and ${totalPages}.`
      : `Use a page between 1 and ${totalPages}, or refine your query.`,
    nextPage: (_query, scope, page) =>
      `\n--- Use page:${page}${short ? `${at}${scope === "all" ? " and scope:'all'" : ""}` : scope === "all" ? " with scope:'all'" : ""} for more results ---`,
    // The agent has its current turn in context, and its question would match itself (an earlier session has none).
    skipCurrentTurn: true,
    aroundHit: (n, scope) => short
      ? `\n--- Read around a hit: session:'${short}', range:[${Math.max(0, n - 3)}, ${n + 3}]; full text: session:'${short}', expand:[${n}] ---`
      : `\n--- Read around a hit: range:[${Math.max(0, n - 3)}, ${n + 3}]; full text: expand:[${n}]${scope === "all" ? " (with scope:'all')" : ""} ---`,
    otherSessions: (n) =>
      `This project has ${n} earlier session${n === 1 ? "" : "s"}: scope:'project' searches ${n === 1 ? "it" : "them"} too; mode:'sessions' lists ${n === 1 ? "it" : "them"}.`,
  };
};

/**
 * One vcc_recall call. `params` is what omp's schema check let through
 * (RECALL_PARAMETERS); normalizeToolParams repairs the loose forms first.
 * `contextWindow` (the model's) scales the output ceiling (recallOutputChars).
 */
export const executeRecall = (
  params: unknown,
  sessionManager: RecallInput["sessionManager"],
  options: { contextWindow?: number } = {},
): string =>
  recall({ request: parseToolRequest(normalizeToolParams(params) as RecallToolParams), sessionManager, ...options }, toolHints).text;

const numberOrText = { anyOf: [{ type: "number" }, { type: "string" }] };
const indices = { anyOf: [{ type: "array", items: numberOrText }, { type: "string" }, { type: "number" }] };
const SCHEMA: Record<(typeof RECALL_PARAMS)[number], object> = {
  query: { type: "string" },
  range: indices,
  expand: indices,
  page: numberOrText,
  scope: { type: "string" },
  mode: { type: "string" },
  session: { type: "string" },
};

const RECALL_PARAMETERS = {
  type: "object",
  properties: Object.fromEntries(RECALL_PARAMS.map((p) => [p, { ...SCHEMA[p], description: RECALL_PARAM_DESCRIPTIONS[p] }])),
} as const;

export const registerRecallTool = (pi: ExtensionAPI, host: Pick<Binding, "window">) => {
  pi.registerTool({
    name: RECALL_TOOL,
    label: RECALL_TOOL_LABEL,
    description: RECALL_TOOL_DESCRIPTION,
    parameters: RECALL_PARAMETERS as any,
    // The summary tells the agent to call vcc_recall by name, so keep it top-level
    // rather than behind omp's tool discovery; it only reads the session file.
    loadMode: "essential",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = executeRecall(params, ctx.sessionManager, { contextWindow: host.window(ctx.model).effective });
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
