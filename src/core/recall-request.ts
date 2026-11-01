import { parseDrillDown } from "./drill-down";
import { normalizeRecallMode, normalizeRecallScope, parseRecallScope, type RecallScope } from "./recall-scope";

export type DrillTarget = NonNullable<ReturnType<typeof parseDrillDown>>;

/** The one thing a recall call does. Exactly one action runs per call. */
export type RecallAction =
  | { kind: "drill"; target: DrillTarget }
  | { kind: "touched"; page?: number }
  | { kind: "sessions"; page: number }
  | { kind: "expand"; indices: number[] }
  | { kind: "range"; range: unknown[]; page: number }
  | { kind: "search"; query: string; page: number }
  | { kind: "recent"; query?: string };

export interface RecallRequest {
  scope: RecallScope;
  action: RecallAction;
  /** An earlier session of this project to run the action in (id prefix, see core/sessions.ts). */
  session?: string;
  /** Params the caller set that this action does not use. Defaults (page:1, expand:[]) are not listed. */
  ignored?: string[];
  /** Values normalizeToolParams could not repair and removed. */
  dropped?: string[];
}

export interface RecallToolParams {
  query?: string;
  expand?: number[];
  range?: unknown[];
  page?: number;
  scope?: string;
  mode?: string;
  session?: string;
}

/** Where normalizeToolParams records values it had to drop; read by parseToolRequest. */
export const DROPPED_KEY = "_vccDropped";

const KNOWN_PARAMS = new Set(["query", "range", "expand", "page", "scope", "mode", "session"]);

/** 12, "12", "#12", " 12 " -> 12. Anything else -> undefined. */
const toIndex = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isInteger(v) ? v : undefined;
  if (typeof v === "string") {
    const m = v.trim().match(/^#?(\d+)$/);
    return m ? Number(m[1]) : undefined;
  }
  return undefined;
};

/** "12", "#12, #15", "12 15" -> numbers; undefined unless the whole string is #N tokens. */
const indexList = (s: string): number[] | undefined => {
  const t = s.trim().replace(/^\[|\]$/g, "");
  if (!/^\s*#?\d+(\s*[,\s]\s*#?\d+)*\s*$/.test(t)) return undefined;
  return (t.match(/\d+/g) ?? []).map(Number);
};

/**
 * Repair argument mistakes whose meaning is certain, before pi validates the
 * schema: numbers sent as strings or with a leading #, a single index where a
 * list is expected, a range written as "10-20" or reversed, enum values in
 * the wrong case, and a scope value put in mode. Values that cannot be
 * repaired are removed and listed under DROPPED_KEY, so the output names them
 * instead of pi rejecting the whole call or recall dropping them silently.
 */
export const normalizeToolParams = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const p: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const dropped: string[] = [];
  const drop = (key: string, why: string) => { dropped.push(`${key} ${JSON.stringify(p[key])} (${why})`); delete p[key]; };

  for (const key of Object.keys(p)) {
    if (!KNOWN_PARAMS.has(key) && key !== DROPPED_KEY) drop(key, "not a vcc_recall param");
  }

  if (p.page !== undefined) {
    const n = toIndex(p.page);
    if (n !== undefined && n >= 1) p.page = n; else drop("page", "not a page number");
  }

  if (p.expand !== undefined) {
    const list = Array.isArray(p.expand) ? p.expand.map(toIndex)
      : typeof p.expand === "string" ? indexList(p.expand)
      : [toIndex(p.expand)];
    if (list && list.every((n) => n !== undefined)) p.expand = list; else drop("expand", "not #N indices");
  }

  if (p.range !== undefined) {
    let pair: (number | undefined)[] | undefined;
    if (Array.isArray(p.range)) pair = p.range.map(toIndex);
    else if (typeof p.range === "string") {
      const m = p.range.trim().match(/^\[?\s*#?(\d+)\s*(?:(?:-|\.\.|,|to)\s*#?(\d+)\s*)?\]?$/i);
      pair = m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined;
    } else pair = [toIndex(p.range)];
    // A single index reads just that entry.
    if (pair?.length === 1) pair = [pair[0], pair[0]];
    if (pair && pair.length === 2 && pair.every((n) => n !== undefined)) {
      const [a, b] = pair as number[];
      p.range = a <= b ? [a, b] : [b, a];
    } else drop("range", "not [from, to]");
  }

  for (const key of ["scope", "mode"] as const) {
    if (typeof p[key] === "string") p[key] = (p[key] as string).trim().toLowerCase();
  }
  if ((p.mode === "all" || p.mode === "lineage") && p.scope === undefined) {
    p.scope = p.mode;
    delete p.mode;
  }
  if ((p.mode === "project") && p.scope === undefined) {
    p.scope = p.mode;
    delete p.mode;
  }
  if (p.scope !== undefined && p.scope !== "lineage" && p.scope !== "all" && p.scope !== "project") drop("scope", "use 'lineage', 'all' or 'project'");
  if (p.mode !== undefined && p.mode !== "hybrid" && p.mode !== "touched" && p.mode !== "sessions") drop("mode", "use 'touched', 'sessions' or leave it out");
  if (p.session !== undefined) {
    if (typeof p.session === "string" && p.session.trim()) p.session = p.session.trim().replace(/^(?:@|session:)/i, "");
    else drop("session", "not a session id");
  }
  if (p.query !== undefined && typeof p.query !== "string") drop("query", "not text");

  if (dropped.length > 0) p[DROPPED_KEY] = dropped;
  return p;
};

/**
 * Tool params -> request. The precedence lives here and only here:
 * #N:path drill-down, then mode:'touched', then expand, then range, then
 * query search, then the most recent entries.
 */
export const parseToolRequest = (params: RecallToolParams): RecallRequest => {
  const scope = normalizeRecallScope(params.scope);
  const q = params.query?.trim();
  const indices = [...new Set(params.expand ?? [])];
  const hasRange = Array.isArray(params.range) && params.range.length > 0;
  const mode = normalizeRecallMode(params.mode);
  const session = typeof params.session === "string" && params.session ? params.session : undefined;
  const set = {
    query: Boolean(q),
    expand: indices.length > 0,
    range: hasRange,
    page: (params.page ?? 1) > 1,
    touched: mode === "touched",
    sessions: mode === "sessions",
  };
  const droppedRaw = (params as Record<string, unknown>)[DROPPED_KEY];
  const dropped = Array.isArray(droppedRaw) && droppedRaw.length > 0 ? droppedRaw.map(String) : undefined;
  const req = (action: RecallAction, uses: (keyof typeof set)[]): RecallRequest => {
    const ignored: string[] = (Object.keys(set) as (keyof typeof set)[])
      .filter((k) => set[k] && !uses.includes(k))
      .map((k) => (k === "touched" || k === "sessions" ? "mode" : k));
    // A listing names sessions, it does not read one; and one session has no
    // earlier sessions of its own to widen to.
    let effectiveScope = scope;
    let target = session;
    if (session && action.kind === "sessions") {
      ignored.push("session");
      target = undefined;
    } else if (session && scope === "project") {
      ignored.push("scope");
      effectiveScope = "lineage";
    }
    const base: RecallRequest = { scope: effectiveScope, action, ...(target ? { session: target } : {}), ...(dropped ? { dropped } : {}) };
    return ignored.length > 0 ? { ...base, ignored } : base;
  };

  const target = q ? parseDrillDown(q) : null;
  if (target) return req({ kind: "drill", target }, ["query"]);
  if (set.touched) return req({ kind: "touched", page: params.page }, ["touched", "page"]);
  if (set.sessions) return req({ kind: "sessions", page: Math.max(1, params.page ?? 1) }, ["sessions", "page"]);
  if (set.expand) return req({ kind: "expand", indices }, ["expand"]);
  if (hasRange) return req({ kind: "range", range: params.range!, page: Math.max(1, params.page ?? 1) }, ["range", "page"]);
  if (q) return req({ kind: "search", query: params.query!, page: Math.max(1, params.page ?? 1) }, ["query", "page"]);
  return req({ kind: "recent", query: params.query }, []);
};

/**
 * /pi-vcc-recall args -> request. A person types a query, scope:all|project,
 * session:<id> and page:N; "sessions" alone lists the earlier sessions.
 */
export const parseCommandRequest = (args: string): RecallRequest => {
  const parsed = parseRecallScope(args.trim());
  const sessionMatch = parsed.text.match(/(?:^|\s)session:(\S+)/i);
  const session = sessionMatch?.[1];
  const rest = parsed.text.replace(/(?:^|\s)session:\S+/i, " ");
  const pageMatch = rest.match(/\bpage:(\d+)\b/i);
  const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
  const query = rest.replace(/\bpage:\d+\b/i, "").trim();
  const scope = session && parsed.scope === "project" ? "lineage" : parsed.scope;
  const target = session ? { session } : {};
  if (!session && /^sessions$/i.test(query)) return { scope, action: { kind: "sessions", page } };
  if (!query) return { scope, action: { kind: "recent" }, ...target };
  return { scope, action: { kind: "search", query, page }, ...target };
};
