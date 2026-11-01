// The vcc_recall tool without a schema library: its name, the text the agent
// reads, and what a call does. Each host binds it with its own schema:
// src/tools/recall.ts (Pi, TypeBox) and src/omp/recall-tool.ts (omp, JSON Schema).
import { normalizeToolParams, parseToolRequest, type RecallToolParams } from "../core/recall-request";
import { dirname } from "path";
import {
  openRecallView,
  openSessionView,
  projectSessions,
  recallOutputChars,
  runRecall,
  sessionHeader,
  type RecallPagingHints,
} from "../core/recall-run";
import { resolveSession } from "../core/sessions";
import type { LineageSessionManagerLike } from "../core/lineage";

export const RECALL_TOOL_NAME = "vcc_recall";
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

export const RECALL_PROMPT_SNIPPET =
  "Recall earlier parts of this session before saying the context is gone. " +
  "One per call: query (search), range:[from, to] (entries in order), expand:[N] (full text), " +
  "mode:'touched' (files), mode:'sessions' / scope:'project' / session:'id' (earlier sessions). " +
  "#N is the number in summary refs like (#12).";

/** Per-parameter descriptions, shared by every host's schema. */
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
};

export interface RecallSessionManager extends LineageSessionManagerLike {
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
 * One vcc_recall call. `params` must already be normalized (normalizeToolParams):
 * Pi does it in prepareArguments, before its schema check; a host without that
 * hook calls executeRecall with `normalize: true`. `contextWindow` (the model's)
 * scales the output ceiling (recallOutputChars).
 */
export const executeRecall = (
  params: unknown,
  sessionManager: RecallSessionManager,
  options: { normalize?: boolean; contextWindow?: number } = {},
): string => {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) return "No session file available.";
  const normalized = (options.normalize ? normalizeToolParams(params) : params) as RecallToolParams;
  const request = parseToolRequest(normalized);
  const project = projectSessions(sessionDirOf(sessionManager, sessionFile), sessionFile);
  const maxChars = recallOutputChars(options.contextWindow);
  if (request.session) {
    const target = resolveSession(request.session, project.list());
    if ("error" in target) return target.error;
    const view = openSessionView(target, request.scope, project);
    return runRecall(request, view, sessionPagingHints(TOOL_PAGING_HINTS, target.short), {
      maxChars: Math.max(0, maxChars - 300),
      header: sessionHeader(target),
    });
  }
  const view = openRecallView(sessionFile, request.scope, sessionManager, { project });
  return runRecall(request, view, TOOL_PAGING_HINTS, { maxChars });
};
