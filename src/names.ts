// omp-vcc's own names: what it registers with the host and what it writes into
// sessions. Whatever writes, matches or mentions one reads it from here.

/** The recall tool, named in the summary, in hints and in omp's placeholders. */
export const RECALL_TOOL = "vcc_recall";
/** The pin tool. */
export const PIN_TOOL = "vcc_pin";

/** Custom entries that hold a pin or unpin (core/pins.ts): in the session file, never in the model's context. */
export const PIN_ENTRY_TYPE = "omp-vcc.pin";
/**
 * Custom message telling the agent about a pin the user made. Left out of the
 * summary, whose [Pinned Notes] carries the note itself.
 */
export const PIN_NOTICE_TYPE = "omp-vcc-pin";
/** Custom message carrying /…-recall output to the agent; summarized as injected text, like any extension's. */
export const RECALL_COMMAND_MESSAGE_TYPE = "vcc-recall";

/** Messages of omp-vcc's own that a summary leaves out. */
export const UNSUMMARIZED_MESSAGE_TYPES: ReadonlySet<string> = new Set([PIN_NOTICE_TYPE]);

/** The compactor id stored in a compaction's details; pi-vcc's is read as ours. */
export const COMPACTOR = "omp-vcc";
export const LEGACY_COMPACTOR = "pi-vcc";
