/**
 * lineage: the current conversation path. all: every branch of this session.
 * project: search also covers this project's earlier sessions (core/sessions.ts).
 */
export type RecallScope = "lineage" | "all" | "project";
export type RecallMode = "hybrid" | "touched" | "sessions";

const SCOPE_RE = /\bscope:(lineage|all|project)\b/i;

const VALID_MODES = new Set(["hybrid", "touched", "sessions"]);

export const normalizeRecallScope = (scope?: unknown): RecallScope => {
  const s = typeof scope === "string" ? scope.toLowerCase() : "";
  return s === "all" || s === "project" ? s : "lineage";
};

/**
 * Normalize a mode param to a supported recall mode. Without OM integration,
 * only "touched" adds behavior beyond the default hybrid search — "file"-only
 * search is not implemented here, so it is not exposed.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const normalizeRecallMode = (mode?: unknown): RecallMode =>
  typeof mode === "string" && VALID_MODES.has(mode.toLowerCase())
    ? (mode.toLowerCase() as RecallMode)
    : "hybrid";

export const parseRecallScope = (text: string): { scope: RecallScope; text: string } => {
  const match = text.match(SCOPE_RE);
  return {
    scope: normalizeRecallScope(match?.[1]),
    text: text.replace(SCOPE_RE, "").replace(/\s+/g, " ").trim(),
  };
};
