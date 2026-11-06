import { readSession, renderMessages, type LoadedEntry, type RecallMessage, type SessionRead } from "./load-messages";
import { searchEntries, type SearchHit, type SearchResult } from "./search-entries";
import { formatRecallOutput } from "./format-recall";
import { formatTouched, touchedFiles } from "./touched";
import { expandEntryFile } from "./drill-down";
import { EXPAND_DETAIL_CHARS } from "./render-entries";
import { ignoredNote, type RecallRequest, type RecallScope } from "./recall-request";
import type { Message } from "@oh-my-pi/pi-ai";
import { describeSession, listProjectSessions, MAX_LISTED_SESSIONS, resolveSession, sessionDirOf, type SessionInfo } from "./sessions";
import { currentBranchIds, hostBranch, type SessionManagerLike } from "./session-file";
import { toolCallsOf } from "./tools";
import { DEFAULT_CHARS_PER_TOKEN } from "./token-estimate";

export const SEARCH_PAGE_SIZE = 5;
export const RANGE_PAGE_SIZE = 20;
const RECENT_COUNT = 25;

/**
 * The session as one recall call sees it. Scope is applied here, once, and
 * every action reads through it. Loads are cached per call.
 */
interface RecallView {
  sessionFile: string;
  scope: RecallScope;
  /** This project's other sessions (mode:'sessions', scope:'project'); unset when unknown. */
  project?: ProjectSessions;
  /** Set when the view is over one of those earlier sessions instead of the current one. */
  session?: SessionInfo;
  load(full: boolean): LoadedEntry[];
  /** One recall result's cap (recallOutputChars). */
  maxChars: number;
  /** The message at `#N`, on any branch. */
  message(index: number): Message | undefined;
  /** What expand shows of one call's arguments and of its paired result (expandDetailChars). */
  detailChars: number;
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
interface ProjectSessions {
  dir: string;
  /** The newest MAX_LISTED_SESSIONS; `more` when there are older ones. */
  list(): SessionInfo[] & { more: boolean };
  /** Every one: an id older than the listed ones still names its session. */
  all(): SessionInfo[];
}

const projectSessions = (dir: string, currentFile: string): ProjectSessions => {
  let listed: ReturnType<typeof listProjectSessions> | undefined;
  let all: SessionInfo[] | undefined;
  return {
    dir,
    list: () => (listed ??= listProjectSessions(dir, currentFile)),
    all: () => (all ??= listProjectSessions(dir, currentFile, Infinity)),
  };
};

interface ViewOptions {
  project?: ProjectSessions;
  session?: SessionInfo;
  /** One recall result's cap; expand's clips follow it (expandDetailChars). */
  maxChars?: number;
  /** The file, read once for every view of it in this call. */
  read?: () => SessionRead;
}

const once = <T>(f: () => T): (() => T) => {
  let value: { v: T } | undefined;
  return () => (value ??= { v: f() }).v;
};

const openRecallView = (
  sessionFile: string,
  scope: RecallScope,
  sessionManager: SessionManagerLike,
  options: ViewOptions = {},
): RecallView => {
  const read = options.read ?? once(() => readSession(sessionFile));
  // scope:'project' reads the current session on its current path, like lineage;
  // only its search reaches further.
  const lineageEntryIds = scope !== "all" ? currentBranchIds(sessionManager) : undefined;
  const cache = new Map<boolean, LoadedEntry[]>();
  let wide: RecallView | undefined;
  let turn: Set<number> | undefined;
  const view: RecallView = {
    sessionFile,
    scope,
    ...(options.project ? { project: options.project } : {}),
    ...(options.session ? { session: options.session } : {}),
    maxChars: options.maxChars ?? RECALL_OUTPUT_CHARS,
    detailChars: expandDetailChars(options.maxChars ?? RECALL_OUTPUT_CHARS),
    load(full) {
      let loaded = cache.get(full);
      if (!loaded) {
        loaded = renderMessages(read().messages, full, lineageEntryIds, { chars: view.detailChars, via: inSession(view) });
        cache.set(full, loaded);
      }
      return loaded;
    },
    message(index) {
      return read().messages.find((m) => m.index === index)?.message;
    },
    widen() {
      if (scope === "all") return view;
      return (wide ??= openRecallView(sessionFile, "all", sessionManager, { ...options, read }));
    },
    currentTurn() {
      // An earlier session has no turn in progress.
      return (turn ??= options.session ? new Set() : findCurrentTurn(read().messages, sessionManager));
    },
  };
  return view;
};

/** A view over one of the project's earlier sessions, on its own active branch. */
const openSessionView = (session: SessionInfo, scope: RecallScope, project?: ProjectSessions, maxChars?: number): RecallView => {
  const read = once(() => readSession(session.file));
  const ids = read().branchIds;
  // A file without entry ids (an old format) has no branch to follow: read all of it.
  const effective = ids.size === 0 ? "all" : scope === "project" ? "lineage" : scope;
  const branch = [...ids].map((id) => ({ id }));
  return openRecallView(session.file, effective, { getBranch: () => branch }, { project, session, maxChars, read });
};

/** What a follow-up call inside an earlier session adds, so it reads that session again. */
const inSession = (view: RecallView): string => (view.session ? ` with session:'${view.session.short}'` : "");

/** "Session 01a194d8 · …" line that opens output read from an earlier session. */
const sessionHeader = (s: SessionInfo): string => `Session ${describeSession(s)}\n\n`;

/**
 * Walk the active path back to the last user message. The tool runs from an
 * agent message the host has already written, so a turn is in progress only when
 * something follows that user message; a compaction in between means the
 * start of the turn may have left the context.
 */
const findCurrentTurn = (messages: readonly RecallMessage[], sessionManager: SessionManagerLike): Set<number> => {
  const none = new Set<number>();
  const branch = hostBranch(sessionManager) ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type === "compaction") return none;
    if (e?.type === "message" && e.message?.role === "user") break;
  }
  const ids = currentBranchIds(sessionManager);
  const onPath = messages.filter((m) => m.id !== undefined && ids.has(m.id));
  for (let i = onPath.length - 1; i >= 0; i--) {
    if (onPath[i].message.role !== "user") continue;
    return i < onPath.length - 1 ? new Set(onPath.slice(i).map((m) => m.index)) : none;
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
    ? Math.max(MIN_RECALL_OUTPUT_CHARS, Math.min(RECALL_OUTPUT_CHARS, Math.round(contextWindow * DEFAULT_CHARS_PER_TOKEN * 0.1)))
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

/** Where a recall call came from: how its follow-up hints are written, for this session or an earlier one (`short`). */
type RecallSurface = (short?: string) => RecallPagingHints;

export interface RecallInput {
  request: RecallRequest;
  sessionManager: SessionManagerLike & { getSessionDir?(): string | undefined };
  /** The model's window: it scales the output cap (recallOutputChars). */
  contextWindow?: number;
}

/**
 * One recall call, for the tool and the command alike: the current session or
 * the earlier one it names, read once, the action run, the output capped
 * (its header included). `ok: false` when there is nothing to read, with how
 * bad that is for a person told so.
 */
export const recall = (input: RecallInput, surface: RecallSurface): { ok: true; text: string } | { ok: false; text: string; severity: "error" | "warning" } => {
  const { request, sessionManager } = input;
  const sessionFile = sessionManager.getSessionFile?.();
  if (!sessionFile) return { ok: false, text: "No session file available.", severity: "error" };
  const project = projectSessions(sessionDirOf(sessionManager, sessionFile), sessionFile);
  const maxChars = recallOutputChars(input.contextWindow);
  if (request.session) {
    const listed = resolveSession(request.session, project.list());
    const target = "error" in listed && project.list().more ? resolveSession(request.session, project.all()) : listed;
    if ("error" in target) return { ok: false, text: target.error, severity: "warning" };
    const header = sessionHeader(target);
    const view = openSessionView(target, request.scope, project, maxChars - header.length);
    return { ok: true, text: header + capOutput(ignoredNote(request) + runAction(request, view, surface), Math.max(0, maxChars - header.length)) };
  }
  const view = openRecallView(sessionFile, request.scope, sessionManager, { project, maxChars });
  return { ok: true, text: capOutput(ignoredNote(request) + runAction(request, view, surface), maxChars) };
};

const runAction = (request: RecallRequest, view: RecallView, surface: RecallSurface): string => {
  const { action } = request;
  const hints = surface(view.session?.short);
  const scopeAll = view.scope === "all";

  switch (action.kind) {
    case "drill": {
      // The entry is read from any branch; scope only decides whether it is off-path.
      const t = action.target;
      const message = view.message(t.index);
      const offPath = message !== undefined && !scopeAll && !view.load(false).some((m) => m.entry.index === t.index);
      return (offPath ? OFF_PATH_NOTE : "") +
        expandEntryFile(message, t.index, t.pathPattern, t.full, t.offset, t.limit, { maxChars: view.maxChars, via: inSession(view) });
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
      if (view.scope === "project") return runProjectSearch(action.query, action.page, view, surface);
      return runSearch(action.query, action.page, view, hints, hints.skipCurrentTurn ? view.currentTurn() : undefined);

    case "recent": {
      return (scopeAll ? "Scope: all\n\n" : "") + formatRecallOutput(view.load(false).slice(-RECENT_COUNT).map((m) => m.entry));
    }
  }
};

/** What expand shows of one call's arguments and of its result: the same share of a smaller cap (a smaller window) as 4,000 chars of 50 KB. */
export const expandDetailChars = (maxChars: number = RECALL_OUTPUT_CHARS): number =>
  Math.max(1, Math.round((maxChars * EXPAND_DETAIL_CHARS) / RECALL_OUTPUT_CHARS));

/**
 * Full text of the requested entries. An expanded tool call brings its tool
 * results along (matched by toolCallId, clipped to the view's detailChars), so
 * the agent does not have to know the result sits at a later #N. Entries off
 * the current path are served from the whole session and named in a note.
 */
const runExpand = (indices: number[], view: RecallView): string => {
  const pools = view.scope === "all" ? [view] : [view, view.widen()];
  const lookup = (i: number) => {
    for (const v of pools) {
      const loaded = v.load(true);
      const pos = loaded.findIndex((m) => m.entry.index === i);
      if (pos >= 0) return { entry: loaded[pos].entry, raw: loaded[pos].message, v, pos };
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
    const ids = new Set(toolCallsOf(raw).flatMap((c) => c.id ?? []));
    if (ids.size === 0) continue;
    const loaded = v.load(true);
    for (let j = pos + 1; j < loaded.length && ids.size > 0; j++) {
      const r = loaded[j].message as any;
      // A call's results come before the next assistant message; past it, a
      // reused id (after an interrupted call) belongs to a later call.
      if (r?.role === "assistant") break;
      if (r?.role !== "toolResult" || !ids.has(r.toolCallId)) continue;
      ids.delete(r.toolCallId);
      const res = loaded[j].entry;
      if (requested.has(res.index)) continue;
      const clipAt = v.detailChars;
      const summary = res.summary.length > clipAt
        ? `${res.summary.slice(0, clipAt)}\n...[result of #${entry.index} clipped at ${clipAt} of ${res.summary.length} chars; expand:[${res.index}]${inSession(v)} for all of it]`
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
 * (session-file.ts), so a ref copied from a summary lands on its message.
 */
const runRange = (range: [number, number], page: number, view: RecallView): string => {
  const [lo, to] = range;
  let hi = to;
  const scopeAll = view.scope === "all";
  const rendered = view.load(false).map((m) => m.entry);
  let entries = rendered.filter((m) => m.index >= lo && m.index <= hi);

  if (entries.length === 0) {
    if (!scopeAll) {
      const wide = view.widen();
      if (wide.load(false).some((m) => m.entry.index >= lo && m.entry.index <= hi)) {
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
  const footer = page < totalPages
    ? `\n--- Use range:[${lo}, ${hi}] page:${page + 1}${scopeAll ? " scope:'all'" : ""}${inSession(view)} for the next ${RANGE_PAGE_SIZE} ---`
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
  const loaded = view.load(false);
  return searchEntries(skip?.size ? loaded.filter((m) => !skip.has(m.entry.index)) : loaded, query);
};

/** A search of this session found nothing: name the project's earlier sessions, which it did not search. */
const otherSessionsNote = (view: RecallView, hints: RecallPagingHints): string => {
  if (!hints.otherSessions || !view.project || view.session || view.scope === "project") return "";
  const count = view.project.list().length;
  return count > 0 ? `\n${hints.otherSessions(count)}` : "";
};

const runSearch = (query: string, page: number, view: RecallView, hints: RecallPagingHints, skip?: Set<number>): string => {
  const result = searchBefore(view, query, skip);
  if (result.aborted) return result.aborted;
  const { hits } = result;
  if (hits.length === 0 && view.scope === "lineage") {
    const wide = view.widen();
    if (searchBefore(wide, query, skip).hits.length > 0) {
      return OFF_PATH_NOTE + runSearch(query, page, wide, hints, skip);
    }
  }
  if (hits.length === 0 && skip?.size) {
    const inTurn = searchEntries(view.load(false), query).hits
      .filter((h) => skip.has(h.index)).length;
    if (inTurn > 0) {
      return `No earlier matches for "${query}"; its ${inTurn} match${inTurn === 1 ? " is" : "es are"} in the current turn, which is already in your context.` +
        otherSessionsNote(view, hints);
    }
  }
  const none = hits.length === 0 ? otherSessionsNote(view, hints) : "";
  return pageOfHits(result, query, page, {
    where: view.scope === "all" ? " (scope: all)" : "",
    scope: view.scope,
    hints,
    around: (top) => hints.aroundHit?.(top.index, view.scope) ?? "",
  }) + none;
};

/**
 * One page of search hits: a header with the count (and how many the hard cap
 * left out), the hits, where to read around the first, and the next page's
 * call. A page past the last says which pages exist: the cap fixes the
 * reachable range, so it is not "no matches".
 */
const pageOfHits = (
  { hits, totalBeforeCap, truncated }: SearchResult,
  query: string,
  page: number,
  opts: { where: string; scope: RecallScope; hints: RecallPagingHints; around: (top: SearchHit) => string },
): string => {
  const totalPages = Math.ceil(hits.length / SEARCH_PAGE_SIZE);
  // Neutral wording ("showing", not "showing top"): regex hits are chronological, unranked.
  const truncationNote = truncated
    ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
    : "";
  if (hits.length > 0 && page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${opts.where}${truncationNote}). ` +
      opts.hints.outOfRange(query, opts.scope, totalPages, truncated);
  }
  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const pageHits = hits.slice(start, start + SEARCH_PAGE_SIZE);
  const header = totalPages > 1
    ? `Page ${page}/${totalPages} (${hits.length} total matches${opts.where}${truncationNote})`
    : `${hits.length} matches${opts.where}${truncationNote}`;
  const around = pageHits.length > 0 ? opts.around(pageHits[0]) : "";
  const footer = page < totalPages ? opts.hints.nextPage(query, opts.scope, page + 1) : "";
  return formatRecallOutput(pageHits, query, header) + around + footer;
};

/** Files worked on, plus a ready #N:path call for the first file on the page that was written. */
const runTouched = (page: number, view: RecallView): string =>
  formatTouched(touchedFiles(view.load(false)), page, inSession(view));

const SESSIONS_PAGE_SIZE = 10;
/** scope:'project' searches at most this much: the newest sessions first. */
const PROJECT_SEARCH_SESSIONS = 20;
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
  const more = view.project?.list().more ? `, the newest ${MAX_LISTED_SESSIONS} (session:'id' reads an older one)` : "";
  const header = totalPages > 1
    ? `Earlier sessions in this project, newest first, page ${page}/${totalPages} (${sessions.length} sessions${more}):`
    : `${sessions.length} earlier session${sessions.length === 1 ? "" : "s"} in this project, newest first${more}:`;
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
const runProjectSearch = (query: string, page: number, view: RecallView, surface: RecallSurface): string => {
  const hints = surface();
  const skip = hints.skipCurrentTurn ? view.currentTurn() : undefined;
  const corpus: LoadedEntry[] = view.load(false).filter((m) => !skip?.has(m.entry.index));
  let bytes = 0;
  let searched = 0;
  const all = view.project?.list() ?? [];
  for (const s of all.slice(0, PROJECT_SEARCH_SESSIONS)) {
    if (bytes + s.bytes > PROJECT_SEARCH_BYTES && searched > 0) break;
    const loaded = openSessionView(s, "lineage").load(false);
    if (corpus.length + loaded.length > PROJECT_SEARCH_ENTRIES && searched > 0) break;
    for (const m of loaded) corpus.push({ entry: { ...m.entry, session: s.short }, message: m.message });
    bytes += s.bytes;
    searched++;
  }
  const covered = searched === 0
    ? "this session (no earlier sessions in this project)"
    : `this session and ${searched} earlier session${searched === 1 ? "" : "s"}${searched < all.length ? ` (the newest ${searched} of ${all.length}; session:'id' reads an older one)` : ""}`;

  const result = searchEntries(corpus, query);
  if (result.aborted) return `${result.aborted} Searching ${covered}: narrow the query, or read one session with session:'id' (mode:'sessions' lists them).`;
  if (result.hits.length === 0) return `No matches for "${query}" in ${covered}.`;
  return pageOfHits(result, query, page, {
    where: ` in ${covered}`,
    scope: "project",
    hints,
    // A hit from an earlier session is read there; one from this session as any other.
    around: (top) => surface(top.session).aroundHit?.(top.index, "lineage") ?? "",
  });
};
