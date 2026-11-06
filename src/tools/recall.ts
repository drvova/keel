// vcc_recall: the text the agent reads, its JSON Schema, and what a call does.
//
// omp validates arguments before any extension code runs and has no
// prepareArguments hook, so the schema also accepts the loose forms
// normalizeToolParams repairs (an index as "#12", a range as "10-20", a scope
// value in mode, enum values in another case); executeRecall then normalizes
// them. omp drops unknown keys itself, before execute().
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { windowOf } from "../hooks/window-limits";
import { normalizeToolParams, parseToolRequest, type RecallToolParams } from "../core/recall-request";
import { dirname } from "path";
import {
  openRecallView,
  openSessionView,
  projectSessions,
  recallOutputChars,
  expandDetailChars,
  runRecall,
  sessionHeader,
  type RecallPagingHints,
} from "../core/recall-run";
import { resolveSession } from "../core/sessions";
import type { SessionManagerLike } from "../core/session-file";
import { RECALL_TOOL } from "../names";

export const RECALL_TOOL_LABEL = "VCC Recall";

export const RECALL_TOOL_DESCRIPTION = [
  "Recall earlier parts of this session, including anything dropped by compaction.",
  "Use it before saying the context is gone.",
  "",
  "Pick one per call:",
  "- query: keyword search (regex works), 5 results per page.",
  "- range: [from, to]: entries #from..#to in order, 20 per page.",
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
  "One result is capped at 50 KB (less on a small context window).",
].join("\n");

/** Per-parameter descriptions, for RECALL_PARAMETERS. */
export const RECALL_PARAM_DESCRIPTIONS = {
  query: "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. '#N:path' instead shows a file's content from entry N.",
  range: "[from, to]: every entry from #from to #to (inclusive) in order, 20 per page. #N is the number in summary refs like (#12) and in recall results.",
  expand: "#N indices to return full content for (from summary refs like (#12) or recall results).",
  page: "Page number (1-based) for query, range or touched results. Default: 1.",
  scope: "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried. 'project' makes a query also search this project's earlier sessions.",
  mode: "hybrid (default) = normal recall; touched = files worked on, by path, with entry indices (misses files written via apply_patch or bash redirects); sessions = this project's earlier sessions, newest first.",
  session: "Id (or its first 8+ characters) of an earlier session from mode:'sessions' or a [session id] hit: the call reads that session instead of this one.",
} as const;

export const TOOL_PAGING_HINTS: RecallPagingHints = {
  outOfRange: (_query, _scope, totalPages, truncated) => truncated
    ? `Use a page between 1 and ${totalPages}.`
    : `Use a page between 1 and ${totalPages}, or refine your query.`,
  nextPage: (_query, scope, page) => `\n--- Use page:${page}${scope === "all" ? " with scope:'all'" : ""} for more results ---`,
  skipCurrentTurn: true,
  aroundHit: (n, scope) =>
    `\n--- Read around a hit: range:[${Math.max(0, n - 3)}, ${n + 3}]; full text: expand:[${n}]${scope === "all" ? " (with scope:'all')" : ""} ---`,
  otherSessions: (n) =>
    `This project has ${n} earlier session${n === 1 ? "" : "s"}: scope:'project' searches ${n === 1 ? "it" : "them"} too; mode:'sessions' lists ${n === 1 ? "it" : "them"}.`,
};

export interface RecallSessionManager extends SessionManagerLike {
  getSessionFile: () => string | undefined;
  /** The directory of this project's session files; the session file's own directory when absent. */
  getSessionDir?: () => string | undefined;
}

/** Paging hints inside an earlier session: the follow-up calls carry session:'id'. */
export const sessionPagingHints = (base: RecallPagingHints, short: string, word = "Use"): RecallPagingHints => ({
  ...base,
  nextPage: (query, scope, page) => `\n--- ${word} page:${page} with session:'${short}'${scope === "all" ? " and scope:'all'" : ""} for more results ---`,
  aroundHit: (n) => `\n--- Read around a hit: session:'${short}', range:[${Math.max(0, n - 3)}, ${n + 3}]; full text: session:'${short}', expand:[${n}] ---`,
  skipCurrentTurn: false,
});

/** The current session's project directory, from the host or the session file. */
export const sessionDirOf = (sessionManager: RecallSessionManager, sessionFile: string): string => {
  try {
    const dir = sessionManager.getSessionDir?.();
    if (typeof dir === "string" && dir) return dir;
  } catch {}
  return dirname(sessionFile);
};

/**
 * One vcc_recall call. `params` is what omp's schema check let through
 * (RECALL_PARAMETERS); normalizeToolParams repairs the loose forms first.
 * `contextWindow` (the model's) scales the output ceiling (recallOutputChars).
 */
export const executeRecall = (
  params: unknown,
  sessionManager: RecallSessionManager,
  options: { contextWindow?: number } = {},
): string => {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) return "No session file available.";
  const request = parseToolRequest(normalizeToolParams(params) as RecallToolParams);
  const project = projectSessions(sessionDirOf(sessionManager, sessionFile), sessionFile);
  const maxChars = recallOutputChars(options.contextWindow);
  const detailChars = expandDetailChars(maxChars);
  if (request.session) {
    const target = resolveSession(request.session, project.list());
    if ("error" in target) return target.error;
    const view = openSessionView(target, request.scope, project, detailChars);
    return runRecall(request, view, sessionPagingHints(TOOL_PAGING_HINTS, target.short), {
      maxChars: Math.max(0, maxChars - 300),
      header: sessionHeader(target),
    });
  }
  const view = openRecallView(sessionFile, request.scope, sessionManager, { project, detailChars });
  return runRecall(request, view, TOOL_PAGING_HINTS, { maxChars });
};

const numberOrText = { anyOf: [{ type: "number" }, { type: "string" }] };

export const RECALL_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: RECALL_PARAM_DESCRIPTIONS.query },
    range: {
      description: RECALL_PARAM_DESCRIPTIONS.range,
      anyOf: [{ type: "array", items: numberOrText }, { type: "string" }, { type: "number" }],
    },
    expand: {
      description: RECALL_PARAM_DESCRIPTIONS.expand,
      anyOf: [{ type: "array", items: numberOrText }, { type: "string" }, { type: "number" }],
    },
    page: { description: RECALL_PARAM_DESCRIPTIONS.page, ...numberOrText },
    scope: { type: "string", description: RECALL_PARAM_DESCRIPTIONS.scope },
    mode: { type: "string", description: RECALL_PARAM_DESCRIPTIONS.mode },
    session: { type: "string", description: RECALL_PARAM_DESCRIPTIONS.session },
  },
} as const;

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: RECALL_TOOL,
    label: RECALL_TOOL_LABEL,
    description: RECALL_TOOL_DESCRIPTION,
    parameters: RECALL_PARAMETERS,
    // The summary tells the agent to call vcc_recall by name, so keep it top-level
    // rather than behind omp's tool discovery; it only reads the session file.
    loadMode: "essential",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = executeRecall(params, ctx.sessionManager, { contextWindow: windowOf(ctx.model).effective });
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
