import { loadAllMessages, type LoadedMessages } from "./load-messages";
import { searchEntriesDetailed, getTouchedFiles, type SearchHit } from "./search-entries";
import { formatRecallOutput, formatTouchedOutput, TOUCHED_PAGE_SIZE } from "./format-recall";
import { getActiveLineageEntryIds, type LineageSessionManagerLike } from "./lineage";
import { expandEntryFile } from "./drill-down";
import type { RecallScope } from "./recall-scope";
import type { RecallRequest } from "./recall-request";
import type { Message } from "@oh-my-pi/pi-ai";
import { describeSession, fileBranchIds, listProjectSessions, type SessionInfo } from "./sessions";

export const SEARCH_PAGE_SIZE = 5;
export const RANGE_PAGE_SIZE = 20;
export const RECENT_COUNT = 25;

/**
 * The session as one recall call sees it. Scope is applied here, once, and
 * every action reads through it. Loads are cached per call.
 */
export interface RecallView {
  sessionFile: string;
  scope: RecallScope;
  /** This project's other sessions (mode:'sessions', scope:'project'); unset when unknown. */
  project?: ProjectSessions;
  /** Set when the view is over one of those earlier sessions instead of the current one. */
  session?: SessionInfo;
  load(full: boolean): LoadedMessages;
  /** The same session with scope:'all' (itself when already 'all'). */
  widen(): RecallView;
  /**
   * #N of the turn in progress on the active path (its last user message and
   * everything after it), all in the agent's context. Empty when there is no
   * turn in progress or the context was compacted inside it.
   */
  currentTurn(): Set<number>;
}

/** The project's other session files, listed once per recall call. */
export interface ProjectSessions {
  dir: string;
  list(): SessionInfo[];
}

export const projectSessions = (dir: string, currentFile: string): ProjectSessions => {
  let listed: SessionInfo[] | undefined;
  return { dir, list: () => (listed ??= listProjectSessions(dir, currentFile)) };
};

export const openRecallView = (
  sessionFile: string,
  scope: RecallScope,
  sessionManager: LineageSessionManagerLike,
  options: { project?: ProjectSessions; session?: SessionInfo } = {},
): RecallView => {
  // scope:'project' reads the current session on its current path, like lineage;
  // only its search reaches further.
  const lineageEntryIds = scope !== "all" ? getActiveLineageEntryIds(sessionManager) : undefined;
  const cache = new Map<boolean, LoadedMessages>();
  let wide: RecallView | undefined;
  let turn: Set<number> | undefined;
  const view: RecallView = {
    sessionFile,
    scope,
    ...(options.project ? { project: options.project } : {}),
    ...(options.session ? { session: options.session } : {}),
    load(full) {
      let loaded = cache.get(full);
      if (!loaded) {
        loaded = loadAllMessages(sessionFile, full, lineageEntryIds);
        cache.set(full, loaded);
      }
      return loaded;
    },
    widen() {
      if (scope === "all") return view;
      return (wide ??= openRecallView(sessionFile, "all", sessionManager, options));
    },
    currentTurn() {
      // An earlier session has no turn in progress.
      return (turn ??= options.session ? new Set() : findCurrentTurn(sessionFile, sessionManager));
    },
  };
  return view;
};

/** A view over one of the project's earlier sessions, on its own active branch. */
export const openSessionView = (session: SessionInfo, scope: RecallScope, project?: ProjectSessions): RecallView => {
  const ids = fileBranchIds(session.file);
  // A file without entry ids (an old format) has no branch to follow: read all of it.
  const effective = !ids?.size ? "all" : scope === "project" ? "lineage" : scope;
  const branch = [...(ids ?? [])].map((id) => ({ id }));
  return openRecallView(session.file, effective, { getBranch: () => branch }, { project, session });
};

/** "Session 01a194d8 · …" line that opens output read from an earlier session. */
export const sessionHeader = (s: SessionInfo): string => `Session ${describeSession(s)}\n\n`;

/**
 * Walk the active path back to the last user message. The tool runs from an
 * agent message pi has already written, so a turn is in progress only when
 * something follows that user message; a compaction in between means the
 * start of the turn may have left the context.
 */
const findCurrentTurn = (sessionFile: string, sessionManager: LineageSessionManagerLike): Set<number> => {
  const none = new Set<number>();
  let branch: any[] = [];
  try { branch = sessionManager.getBranch() ?? []; } catch { return none; }
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type === "compaction") return none;
    if (e?.type === "message" && e.message?.role === "user") break;
  }
  const { rendered } = loadAllMessages(sessionFile, false, getActiveLineageEntryIds(sessionManager));
  for (let i = rendered.length - 1; i >= 0; i--) {
    if (rendered[i].role !== "user") continue;
    return i < rendered.length - 1 ? new Set(rendered.slice(i).map((m) => m.index)) : none;
  }
  return none;
};

/**
 * When the current conversation path has nothing for a query, range or
 * #N:path, recall answers from edited or retried branches instead and says so
 * on the first line. An explicit scope:'all' never needs this.
 */
const OFF_PATH_NOTE =
  "Nothing on the current conversation path; showing edited or retried branches (scope:'all').\n\n";

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

/** Surface-specific wording: the tool says page:N, the command says /omp-vcc-recall … page:N. */
export interface RecallPagingHints {
  outOfRange(query: string, scope: RecallScope, totalPages: number, truncated: boolean): string;
  nextPage(query: string, scope: RecallScope, page: number): string;
  /** Next step after a search page, pointing at its first hit. The command has none. */
  aroundHit?(index: number, scope: RecallScope): string;
  /**
   * Leave the current turn (last user message on the path and everything after
   * it) out of search: the agent has it in context, and its question would
   * otherwise match itself. Only the tool sets this; a /omp-vcc-recall command
   * adds no user message, so the last one there belongs to a finished turn.
   */
  skipCurrentTurn?: boolean;
  /** After a search of this session finds nothing: where the project's earlier sessions are. */
  otherSessions?(count: number): string;
}


const IGNORED_REASON: Record<RecallRequest["action"]["kind"], string> = {
  drill: "a #N:path query runs alone",
  touched: "mode:'touched' runs alone",
  expand: "expand runs alone; send the rest in a separate call",
  range: "range runs alone; send the rest in a separate call",
  sessions: "mode:'sessions' runs alone",
  search: "",
  recent: "page applies to query or range results",
};

/** One line naming params the action did not use, so nothing is dropped silently. */
export const ignoredNote = (request: RecallRequest): string =>
  (request.dropped?.length ? `Ignored: ${request.dropped.join(", ")}.\n\n` : "") +
  (request.ignored?.length
    ? `Ignored: ${request.ignored.join(", ")} (${IGNORED_REASON[request.action.kind]}).\n\n`
    : "");

/** Ceiling for one recall result, 50 KB like a read tool's: one long entry
 *  (a base64 image on one line) must not flood the context. */
export const RECALL_OUTPUT_CHARS = 50 * 1024;
const MIN_RECALL_OUTPUT_CHARS = 8 * 1024;

/**
 * The ceiling for a model's context window: a tenth of it (at ~4 chars per
 * token), between 8 KB and 50 KB. A large result costs more than its tokens:
 * accuracy drops with input length alone (arXiv:2510.05381), and on a small
 * window a 50 KB result can by itself push the session back over its
 * compaction threshold. Unknown window: 50 KB.
 */
export const recallOutputChars = (contextWindow?: number): number =>
  typeof contextWindow === "number" && contextWindow > 0
    ? Math.max(MIN_RECALL_OUTPUT_CHARS, Math.min(RECALL_OUTPUT_CHARS, Math.round(contextWindow * 4 * 0.1)))
    : RECALL_OUTPUT_CHARS;

const kb = (chars: number): string => `${Math.round(chars / 1024)} KB`;

const capOutput = (text: string, max: number): string => {
  if (text.length <= max) return text;
  // Never split a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return `Warning: output clipped at ${end} of ${text.length} chars (one recall result is capped at ${kb(max)}). ` +
    `Ask for less at once: fewer expand indices, a narrower query, or a line range for file content ('#N:path:offset:limit').\n\n` +
    `${text.slice(0, end)}\n...[clipped at ${kb(max)}]`;
};

export const runRecall = (
  request: RecallRequest,
  view: RecallView,
  hints: RecallPagingHints,
  /** header: a first line ahead of the output (which session it was read from). */
  options: { maxChars?: number; header?: string } = {},
): string =>
  (options.header ?? "") + capOutput(ignoredNote(request) + runAction(request, view, hints), options.maxChars ?? RECALL_OUTPUT_CHARS);

const runAction = (request: RecallRequest, view: RecallView, hints: RecallPagingHints): string => {
  const { action } = request;
  const scopeAll = view.scope === "all";

  switch (action.kind) {
    case "drill": {
      // expandEntryFile loads unfiltered so #N stays aligned with the global
      // message index; scope only decides whether the entry is off-path.
      const t = action.target;
      const offPath = !scopeAll && !view.load(false).rendered.some((m) => m.index === t.index);
      return (offPath ? OFF_PATH_NOTE : "") +
        expandEntryFile(view.sessionFile, t.index, t.pathPattern, t.full, t.offset, t.limit);
    }

    case "touched":
      return runTouched(action.page, view);

    case "sessions":
      return runSessions(action.page, view);

    case "expand":
      return runExpand(action.indices, view);

    case "range":
      return runRange(action.range, action.page, view);

    case "search":
      if (view.scope === "project") return runProjectSearch(action.query, action.page, view, hints);
      return runSearch(action.query, action.page, view, hints, hints.skipCurrentTurn ? view.currentTurn() : undefined);

    case "recent": {
      const { rendered } = view.load(false);
      return (scopeAll ? "Scope: all\n\n" : "") + formatRecallOutput(rendered.slice(-RECENT_COUNT), action.query);
    }
  }
};

/** Tool output shown with an expanded call, clipped so one expand cannot flood the context. */
export const PAIRED_RESULT_CHARS = 4000;

const toolCallIds = (msg: Message | undefined): string[] =>
  msg?.role === "assistant" && Array.isArray(msg.content)
    ? msg.content.flatMap((b: any) => (b?.type === "toolCall" && typeof b.id === "string" ? [b.id] : []))
    : [];

/**
 * Full text of the requested entries. An expanded tool call brings its tool
 * results along (matched by toolCallId, clipped to PAIRED_RESULT_CHARS), so
 * the agent does not have to know the result sits at a later #N. Entries off
 * the current path are served from the whole session and named in a note.
 */
const runExpand = (indices: number[], view: RecallView): string => {
  const pools = view.scope === "all" ? [view] : [view, view.widen()];
  const lookup = (i: number) => {
    for (const v of pools) {
      const { rendered, rawMessages } = v.load(true);
      const pos = rendered.findIndex((m) => m.index === i);
      if (pos >= 0) return { entry: rendered[pos], raw: rawMessages[pos], v, pos };
    }
    return undefined;
  };

  const found = indices.map((i) => ({ i, hit: Number.isInteger(i) ? lookup(i) : undefined }));
  const invalid = found.filter((f) => !f.hit).map((f) => f.i);
  if (invalid.length > 0) return `Cannot expand indices outside session history: ${invalid.join(", ")}`;

  const offPath = found.filter((f) => f.hit!.v !== view).map((f) => `#${f.i}`);
  const requested = new Set(indices);
  const out: SearchHit[] = [];
  for (const { hit } of found) {
    const { entry, raw, v, pos } = hit!;
    out.push(entry);
    const ids = new Set(toolCallIds(raw));
    if (ids.size === 0) continue;
    const { rendered, rawMessages } = v.load(true);
    for (let j = pos + 1; j < rendered.length && ids.size > 0; j++) {
      const r = rawMessages[j] as any;
      // A call's results come before the next assistant message; past it, a
      // reused id (after an interrupted call) belongs to a later call.
      if (r?.role === "assistant") break;
      if (r?.role !== "toolResult" || !ids.has(r.toolCallId)) continue;
      ids.delete(r.toolCallId);
      const res = rendered[j];
      if (requested.has(res.index)) continue;
      const summary = res.summary.length > PAIRED_RESULT_CHARS
        ? `${res.summary.slice(0, PAIRED_RESULT_CHARS)}\n...[result of #${entry.index} clipped at ${PAIRED_RESULT_CHARS} of ${res.summary.length} chars; expand:[${res.index}] for all of it]`
        : res.summary;
      out.push({ ...res, summary });
    }
  }

  const header = `Expanded ${indices.map((i) => `#${i}`).join(", ")}`;
  const note = offPath.length > 0
    ? `${offPath.join(", ")} ${offPath.length === 1 ? "is" : "are"} not on the current conversation path (edited or retried branch).\n\n`
    : "";
  return (view.scope === "all" ? "Scope: all\n\n" : "") + note + formatRecallOutput(out, undefined, header);
};

/**
 * Entries #from..#to in order, RANGE_PAGE_SIZE per page, same per-entry clip
 * as search and recent. Indices are the global #N space shared with summaries
 * (global-indices.ts), so a ref copied from a summary lands on its message.
 */
const runRange = (range: unknown[], page: number, view: RecallView): string => {
  const [from, to] = range;
  if (range.length !== 2 || !Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (from as number) > (to as number)) {
    return `Invalid range ${JSON.stringify(range)}: use range:[from, to] with two #N indices, from <= to.`;
  }
  const lo = from as number;
  let hi = to as number;
  const scopeAll = view.scope === "all";
  const { rendered } = view.load(false);
  let entries = rendered.filter((m) => m.index >= lo && m.index <= hi);

  if (entries.length === 0) {
    if (!scopeAll) {
      const wide = view.widen();
      if (wide.load(false).rendered.some((m) => m.index >= lo && m.index <= hi)) {
        return OFF_PATH_NOTE + runRange(range, page, wide);
      }
    }
    const last = rendered[rendered.length - 1];
    return `No messages #${lo}..#${hi} in session history${last ? ` (last entry is #${last.index})` : ""}.`;
  }

  // A range past the end is read up to the last entry, and the header says so.
  const lastIndex = rendered[rendered.length - 1].index;
  const clamped = hi > lastIndex;
  if (clamped) hi = lastIndex;

  const totalPages = Math.ceil(entries.length / RANGE_PAGE_SIZE);
  const counts = `${entries.length} messages${scopeAll ? ", scope: all" : ""}${clamped ? `, #${hi} is the last entry` : ""}`;
  if (page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} (#${lo}..#${hi}: ${counts}). Use a page between 1 and ${totalPages}.`;
  }
  const start = (page - 1) * RANGE_PAGE_SIZE;
  const header = totalPages > 1
    ? `Range #${lo}..#${hi}, page ${page}/${totalPages} (${counts})`
    : `Range #${lo}..#${hi} (${counts})`;
  const inSession = view.session ? ` session:'${view.session.short}'` : "";
  const footer = page < totalPages
    ? `\n--- Use range:[${lo}, ${hi}] page:${page + 1}${inSession}${scopeAll ? " scope:'all'" : ""} for the next ${RANGE_PAGE_SIZE} ---`
    : "";
  return formatRecallOutput(entries.slice(start, start + RANGE_PAGE_SIZE), undefined, header) + footer;
};

/**
 * Search with the current turn left out of the corpus, not just out of the
 * results: filtering afterwards let turn entries win the regex path (so the
 * term fallback never ran), set the relative floor, and fill the hit cap,
 * which hid earlier matches.
 */
const searchBefore = (view: RecallView, query: string, skip: Set<number> | undefined) => {
  const { rendered, rawMessages } = view.load(false);
  if (!skip?.size) return searchEntriesDetailed(rendered, rawMessages, query);
  const keep = rendered.map((m) => !skip.has(m.index));
  return searchEntriesDetailed(rendered.filter((_, i) => keep[i]), rawMessages.filter((_, i) => keep[i]), query);
};

/** A search of this session found nothing: name the project's earlier sessions, which it did not search. */
const otherSessionsNote = (view: RecallView, hints: RecallPagingHints): string => {
  if (!hints.otherSessions || !view.project || view.session || view.scope === "project") return "";
  let count = 0;
  try { count = view.project.list().length; } catch {}
  return count > 0 ? `\n${hints.otherSessions(count)}` : "";
};

const runSearch = (query: string, page: number, view: RecallView, hints: RecallPagingHints, skip?: Set<number>): string => {
  const { hits, totalBeforeCap, truncated } = searchBefore(view, query, skip);
  if (hits.length === 0 && view.scope === "lineage") {
    const wide = view.widen();
    if (searchBefore(wide, query, skip).hits.length > 0) {
      return OFF_PATH_NOTE + runSearch(query, page, wide, hints, skip);
    }
  }
  if (hits.length === 0 && skip?.size) {
    const inTurn = searchEntriesDetailed(view.load(false).rendered, view.load(false).rawMessages, query).hits
      .filter((h) => skip.has(h.index)).length;
    if (inTurn > 0) {
      return `No earlier matches for "${query}"; its ${inTurn} match${inTurn === 1 ? " is" : "es are"} in the current turn, which is already in your context.` +
        otherSessionsNote(view, hints);
    }
  }
  // Single source of truth for page count: hits.length, the same array
  // that's actually paginated below (already floor-filtered and capped).
  const totalPages = Math.ceil(hits.length / SEARCH_PAGE_SIZE);
  const scopeSuffix = view.scope === "all" ? " (scope: all)" : "";
  // The hard cap can discard genuine matches; hits.length alone would then
  // understate the real total. Say so explicitly. Neutral wording ("showing",
  // not "showing top"): regex-path hits are chronological with no relevance
  // score, so "top" would falsely imply a ranking only the BM25 path has.
  const truncationNote = truncated
    ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
    : "";

  // The hard cap creates a fixed reachable page range (1..totalPages). A page
  // beyond it isn't "no matches": say which pages exist instead of falling
  // through to formatRecallOutput's zero-hit message, which would be false.
  if (hits.length > 0 && page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} ` +
      `(${hits.length} matches${scopeSuffix}${truncationNote}). ` +
      hints.outOfRange(query, view.scope, totalPages, truncated);
  }

  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const pageHits = hits.slice(start, start + SEARCH_PAGE_SIZE);
  const header = totalPages > 1
    ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})`
    : `${hits.length} matches${scopeSuffix}${truncationNote}`;
  const around = pageHits.length > 0 && hints.aroundHit ? hints.aroundHit(pageHits[0].index, view.scope) : "";
  const footer = page < totalPages ? hints.nextPage(query, view.scope, page + 1) : "";
  const none = hits.length === 0 ? otherSessionsNote(view, hints) : "";
  return formatRecallOutput(pageHits, query, header) + around + footer + none;
};

const WRITES_FILE = /write|edit|patch/i;

/** Files worked on, plus a ready #N:path call for the first file on the page that was written. */
const runTouched = (page: number | undefined, view: RecallView): string => {
  const { rendered, rawMessages } = view.load(false);
  const touched = getTouchedFiles(rawMessages, rendered);
  const text = formatTouchedOutput(touched, page);
  const start = (Math.max(1, page ?? 1) - 1) * TOUCHED_PAGE_SIZE;
  for (const tf of touched.slice(start, start + TOUCHED_PAGE_SIZE)) {
    const write = [...tf.entries].reverse().find((e) => e.drillable !== false && WRITES_FILE.test(e.toolName));
    if (!write) continue;
    const name = tf.path.replace(/\\/g, "/").split("/").pop();
    return `${text}\n--- File content at an entry: query:'#${write.index}:${name}' ---`;
  }
  return text;
};

// ── Earlier sessions of this project ──────────────────────────────────────

export const SESSIONS_PAGE_SIZE = 10;
/** scope:'project' searches at most this much: the newest sessions first. */
export const PROJECT_SEARCH_SESSIONS = 20;
const PROJECT_SEARCH_BYTES = 24 * 1024 * 1024;
const PROJECT_SEARCH_ENTRIES = 40_000;

const runSessions = (page: number, view: RecallView): string => {
  const sessions = view.project?.list() ?? [];
  if (sessions.length === 0) return "No earlier sessions in this project (the session directory has no other session files).";
  const totalPages = Math.ceil(sessions.length / SESSIONS_PAGE_SIZE);
  if (page > totalPages) return `Page ${page} is outside the available range 1-${totalPages} (${sessions.length} earlier sessions).`;
  const start = (page - 1) * SESSIONS_PAGE_SIZE;
  const lines = sessions.slice(start, start + SESSIONS_PAGE_SIZE).map((s) =>
    `${describeSession(s)}${s.pins.length > 0 ? `\n  pinned: ${s.pins.join("; ")}` : ""}`);
  const header = totalPages > 1
    ? `Earlier sessions in this project, newest first, page ${page}/${totalPages} (${sessions.length} sessions):`
    : `${sessions.length} earlier session${sessions.length === 1 ? "" : "s"} in this project, newest first:`;
  const next = page < totalPages ? `\n--- Use mode:'sessions' page:${page + 1} for more ---` : "";
  const first = sessions[start].short;
  return `${header}\n\n${lines.join("\n")}\n` +
    `\n--- Read one: session:'${first}' with a query, range, expand or mode:'touched'; search all: a query with scope:'project' ---${next}`;
};

/**
 * One search over this session (current path, current turn left out) and the
 * project's newest earlier sessions (their active branches), as one corpus so
 * the ranking is comparable across them. Bounded by session count, bytes and
 * entries; a hit names its session.
 */
const runProjectSearch = (query: string, page: number, view: RecallView, hints: RecallPagingHints): string => {
  const skip = hints.skipCurrentTurn ? view.currentTurn() : undefined;
  const own = view.load(false);
  const rendered: SearchHit[] = [];
  const raws: Message[] = [];
  own.rendered.forEach((e, i) => {
    if (skip?.has(e.index)) return;
    rendered.push(e);
    raws.push(own.rawMessages[i]);
  });
  let bytes = 0;
  let searched = 0;
  const all = view.project?.list() ?? [];
  for (const s of all.slice(0, PROJECT_SEARCH_SESSIONS)) {
    if (bytes + s.bytes > PROJECT_SEARCH_BYTES && searched > 0) break;
    const loaded = openSessionView(s, "lineage").load(false);
    if (rendered.length + loaded.rendered.length > PROJECT_SEARCH_ENTRIES && searched > 0) break;
    loaded.rendered.forEach((e, i) => {
      rendered.push({ ...e, session: s.short });
      raws.push(loaded.rawMessages[i]);
    });
    bytes += s.bytes;
    searched++;
  }
  const covered = searched === 0
    ? "this session (no earlier sessions in this project)"
    : `this session and ${searched} earlier session${searched === 1 ? "" : "s"}${searched < all.length ? ` (the newest ${searched} of ${all.length}; session:'id' reads an older one)` : ""}`;

  let result;
  try {
    result = searchEntriesDetailed(rendered, raws, query);
  } catch (err) {
    return `${(err as Error).message} Searching ${covered}: narrow the query, or read one session with session:'id' (mode:'sessions' lists them).`;
  }
  const { hits, totalBeforeCap, truncated } = result;
  if (hits.length === 0) return `No matches for "${query}" in ${covered}.`;
  const totalPages = Math.ceil(hits.length / SEARCH_PAGE_SIZE);
  if (page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches in ${covered}). ` +
      hints.outOfRange(query, "project", totalPages, truncated);
  }
  const truncationNote = truncated ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query` : "";
  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const pageHits = hits.slice(start, start + SEARCH_PAGE_SIZE);
  const header = totalPages > 1
    ? `Page ${page}/${totalPages} (${hits.length} total matches in ${covered}${truncationNote})`
    : `${hits.length} matches in ${covered}${truncationNote}`;
  const top = pageHits[0];
  const around = top?.session
    ? `\n--- Read around a hit: session:'${top.session}', range:[${Math.max(0, top.index - 3)}, ${top.index + 3}]; full text: session:'${top.session}', expand:[${top.index}] ---`
    : top && hints.aroundHit ? hints.aroundHit(top.index, "lineage") : "";
  const footer = page < totalPages ? hints.nextPage(query, "project", page + 1) : "";
  return formatRecallOutput(pageHits, query, header) + around + footer;
};
