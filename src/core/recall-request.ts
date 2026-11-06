// A recall call as one request, from the tool's params or the command's text.
import { parseDrillDown } from "./drill-down";

export type DrillTarget = NonNullable<ReturnType<typeof parseDrillDown>>;

/**
 * lineage: the current conversation path. all: every branch of this session.
 * project: search also covers this project's earlier sessions (core/sessions.ts).
 */
export const SCOPES = ["lineage", "all", "project"] as const;
export type RecallScope = (typeof SCOPES)[number];
/** hybrid: the default, a query, range, expand or the latest entries. */
export const MODES = ["hybrid", "touched", "sessions"] as const;
export type RecallMode = (typeof MODES)[number];

/** The one thing a recall call does. Exactly one action runs per call. */
export type RecallAction =
  | { kind: "drill"; target: DrillTarget }
  | { kind: "touched"; page: number }
  | { kind: "sessions"; page: number }
  | { kind: "expand"; indices: number[] }
  | { kind: "range"; range: [number, number]; page: number }
  | { kind: "search"; query: string; page: number }
  | { kind: "recent" };

/** A param the call set that its action does not use, and why. */
export interface IgnoredParam {
  param: string;
  why: string;
}

export interface RecallRequest {
  scope: RecallScope;
  action: RecallAction;
  /** An earlier session of this project to run the action in (id prefix, see core/sessions.ts). */
  session?: string;
  /** Params the caller set that this action does not use. Defaults (page:1, expand:[]) are not listed. */
  ignored?: IgnoredParam[];
  /** Values normalizeToolParams could not repair and removed. */
  dropped?: string[];
}

/** vcc_recall's params: the one list of them, for the type, the known keys and the JSON Schema. */
export const RECALL_PARAMS = ["query", "range", "expand", "page", "scope", "mode", "session"] as const;

export interface RecallToolParams {
  query?: string;
  expand?: number[];
  range?: number[];
  page?: number;
  scope?: RecallScope;
  mode?: RecallMode;
  session?: string;
}

/** Where normalizeToolParams records values it had to drop; read by parseToolRequest. */
export const DROPPED_KEY = "_vccDropped";

const isScope = (v: unknown): v is RecallScope => (SCOPES as readonly unknown[]).includes(v);
const isMode = (v: unknown): v is RecallMode => (MODES as readonly unknown[]).includes(v);

/** 12, "12", "#12", " 12 " -> 12. Anything else (a fraction, a negative) -> undefined. */
const toIndex = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : undefined;
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

/** "@01a1", "session:01a1" -> "01a1": how a session id is written in output and by hand. */
export const sessionRef = (ref: string): string => ref.trim().replace(/^(?:@|session:)/i, "");

/**
 * Repair argument mistakes whose meaning is certain, before the host
 * validates the schema: numbers sent as strings or with a leading #, a single
 * index where a list is expected, a range written as "10-20" or reversed, enum
 * values in the wrong case, and a scope value put in mode. Values that cannot
 * be repaired are removed and listed under DROPPED_KEY, so the output names
 * them instead of the host rejecting the whole call or recall dropping them
 * silently.
 */
export const normalizeToolParams = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const p: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const dropped: string[] = [];
  const drop = (key: string, why: string) => { dropped.push(`${key} ${JSON.stringify(p[key])} (${why})`); delete p[key]; };

  for (const key of Object.keys(p)) {
    if (!(RECALL_PARAMS as readonly string[]).includes(key) && key !== DROPPED_KEY) drop(key, "not a vcc_recall param");
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
  // A scope value put in mode means the scope.
  if (p.scope === undefined && isScope(p.mode)) {
    p.scope = p.mode;
    delete p.mode;
  }
  if (p.scope !== undefined && !isScope(p.scope)) drop("scope", "use 'lineage', 'all' or 'project'");
  if (p.mode !== undefined && !isMode(p.mode)) drop("mode", "use 'touched', 'sessions' or leave it out");
  if (p.session !== undefined) {
    if (typeof p.session === "string" && sessionRef(p.session)) p.session = sessionRef(p.session);
    else drop("session", "not a session id");
  }
  if (p.query !== undefined && typeof p.query !== "string") drop("query", "not text");

  if (dropped.length > 0) p[DROPPED_KEY] = dropped;
  return p;
};

/** What a call names, whichever surface it came from. */
interface RequestParts {
  query?: string;
  expand?: number[];
  range?: [number, number];
  page?: number;
  scope?: RecallScope;
  mode?: RecallMode;
  session?: string;
  dropped?: string[];
}

const ALONE: Record<Exclude<RecallAction["kind"], "search">, string> = {
  drill: "a #N:path query runs alone",
  touched: "mode:'touched' runs alone",
  sessions: "mode:'sessions' runs alone",
  expand: "expand runs alone; send the rest in a separate call",
  range: "range runs alone; send the rest in a separate call",
  recent: "page applies to query or range results",
};

/**
 * The request from what a call names. The precedence lives here and only
 * here: #N:path drill-down, then mode:'touched', mode:'sessions', expand,
 * range, query search, and the most recent entries.
 */
const requestOf = (parts: RequestParts): RecallRequest => {
  const query = parts.query?.trim() ? parts.query : undefined;
  const expand = [...new Set(parts.expand ?? [])];
  const page = Math.max(1, parts.page ?? 1);
  const drill = query ? parseDrillDown(query.trim()) : null;
  const action: RecallAction =
    drill ? { kind: "drill", target: drill }
    : parts.mode === "touched" ? { kind: "touched", page }
    : parts.mode === "sessions" ? { kind: "sessions", page }
    : expand.length > 0 ? { kind: "expand", indices: expand }
    : parts.range ? { kind: "range", range: parts.range, page }
    : query ? { kind: "search", query, page }
    : { kind: "recent" };
  const set = {
    query: Boolean(query) && action.kind !== "drill" && action.kind !== "search",
    expand: expand.length > 0 && action.kind !== "expand",
    range: Boolean(parts.range) && action.kind !== "range",
    page: page > 1 && !("page" in action),
    mode: Boolean(parts.mode && parts.mode !== "hybrid") && action.kind !== "touched" && action.kind !== "sessions",
  };
  const why = action.kind === "search" ? "" : ALONE[action.kind];
  const ignored: IgnoredParam[] = (Object.keys(set) as (keyof typeof set)[])
    .filter((k) => set[k])
    .map((param) => ({ param, why }));
  let scope: RecallScope = parts.scope ?? "lineage";
  let session = parts.session;
  if (session && action.kind === "sessions") {
    ignored.push({ param: "session", why: "mode:'sessions' lists the sessions, it does not read one" });
    session = undefined;
  } else if (session && scope === "project") {
    ignored.push({ param: "scope", why: "scope:'project' searches from this session; one earlier session has no earlier ones of its own" });
    scope = "lineage";
  }
  return {
    scope,
    action,
    ...(session ? { session } : {}),
    ...(ignored.length > 0 ? { ignored } : {}),
    ...(parts.dropped?.length ? { dropped: parts.dropped } : {}),
  };
};

/** Tool params (normalizeToolParams' output) -> request. */
export const parseToolRequest = (params: RecallToolParams): RecallRequest => {
  const droppedRaw = (params as Record<string, unknown>)[DROPPED_KEY];
  return requestOf({
    ...params,
    range: Array.isArray(params.range) && params.range.length === 2 ? [params.range[0], params.range[1]] : undefined,
    dropped: Array.isArray(droppedRaw) ? droppedRaw.map(String) : undefined,
  });
};

/**
 * /omp-vcc-recall args -> request. A person types a query, scope:all|project,
 * session:<id> and page:N; "sessions" alone lists the earlier sessions.
 */
export const parseCommandRequest = (args: string): RecallRequest => {
  let text = args.trim();
  const take = (re: RegExp): string | undefined => {
    const m = text.match(re);
    if (m) text = text.replace(re, " ").replace(/\s+/g, " ").trim();
    return m?.[1];
  };
  const scope = take(/\bscope:(lineage|all|project)\b/i)?.toLowerCase() as RecallScope | undefined;
  const session = take(/(?:^|\s)session:(\S+)/i);
  const page = take(/\bpage:(\d+)\b/i);
  const sessions = !session && /^sessions$/i.test(text);
  return requestOf({
    query: sessions ? undefined : text,
    mode: sessions ? "sessions" : undefined,
    page: page ? parseInt(page, 10) : undefined,
    scope,
    session: session ? sessionRef(session) : undefined,
  });
};

/** One line per reason naming the params the action did not use, so nothing is dropped silently. */
export const ignoredNote = (request: RecallRequest): string => {
  const dropped = request.dropped?.length ? `Ignored: ${request.dropped.join(", ")}.\n` : "";
  const byReason = new Map<string, string[]>();
  for (const { param, why } of request.ignored ?? []) byReason.set(why, [...(byReason.get(why) ?? []), param]);
  const ignored = [...byReason].map(([why, params]) => `Ignored: ${params.join(", ")}${why ? ` (${why})` : ""}.\n`).join("");
  return dropped || ignored ? `${dropped}${ignored}\n` : "";
};
