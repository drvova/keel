// keel's own names, and the limits its tools' descriptions state: a copy of
// the core's (lisp/src/names.lisp), since the tools are registered with their
// descriptions before a core may exist. tests/names.test.ts holds it to the core's.

/** The recall tool, named in the summary, in hints and in omp's placeholders. */
export const RECALL_TOOL = "keel_recall";
/** keel_recall's params, for its JSON Schema. */
export const RECALL_PARAMS = ["query", "range", "expand", "page", "scope", "mode", "session"] as const;
export const PIN_TOOL = "keel_pin";
/** keel_pin's params, for its JSON Schema. */
export const PIN_PARAMS = ["note", "name", "unpin"] as const;

/** Custom entries that hold a pin or unpin: in the session file, never in the model's context. */
export const PIN_ENTRY_TYPE = "keel.pin";
/** keel_context, the agent's say over what stays in its context, and what it takes. */
export const CONTEXT_TOOL = "keel_context";
export const CONTEXT_PARAMS = ["drop", "oldest", "restore", "note", "undo", "force"] as const;
/** The custom entries that take turns out of the context or bring them back. */
export const EVICT_ENTRY_TYPE = "keel.evict";
/** The same entries as keel wrote them under its earlier name, omp-vcc: read as its own. */
export const LEGACY_PIN_ENTRY_TYPE = "omp-vcc.pin";
export const LEGACY_EVICT_ENTRY_TYPE = "omp-vcc.evict";
export const isPinEntryType = (t: unknown) => t === PIN_ENTRY_TYPE || t === LEGACY_PIN_ENTRY_TYPE;
export const isEvictEntryType = (t: unknown) => t === EVICT_ENTRY_TYPE || t === LEGACY_EVICT_ENTRY_TYPE;
/** The custom message telling the agent of a pin the user made; a summary leaves it out. */
export const PIN_NOTICE_TYPE = "keel-pin";
/** The custom message telling the agent how full its context is; a summary leaves it out. */
export const BUDGET_NOTICE_TYPE = "keel-budget";
/** The custom message carrying /…-recall output to the agent. */
export const RECALL_COMMAND_MESSAGE_TYPE = "keel-recall";

/** Hits on one page of a search, entries on one page of a range. */
export const SEARCH_PAGE_SIZE = 5;
export const RANGE_PAGE_SIZE = 20;
/** One recall result's ceiling, 50 KB; less on a small context window. */
export const RECALL_OUTPUT_CHARS = 50 * 1024;
/** A pinned note is clipped to this many characters. */
export const PIN_CHARS = 300;
export const PIN_NAME_CHARS = 40;
/** A keel_context note is clipped to this many characters. */
export const CONTEXT_NOTE_CHARS = 300;
/** Past this percent of where the host compacts, the oldest finished turns leave the context. */
export const EVICT_AT_PERCENT = 85;
/** The shortest id prefix session:'id' takes. */
export const SESSION_REF_MIN_CHARS = 4;
