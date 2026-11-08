// keel's names and limits as the core holds them (lisp/src/names.lisp), for
// tests that write them into sessions, instructions and expectations.
import { core } from "../../src/core";

const names = core({ op: "names" }).names as Record<string, any>;

export const PIN_ENTRY_TYPE: string = names.pinEntryType;
export const EVICT_ENTRY_TYPE: string = names.evictEntryType;
export const RECALL_ENTRY_TYPE: string = names.recallEntryType;
/** The custom messages keel sends the agent: a pin the user made, where the last session stopped. */
export const PIN_NOTICE_TYPE: string = names.pinNoticeType;
export const RESUME_NOTICE_TYPE: string = names.resumeNoticeType;
/** The store of omp's rewritten originals beside a session file. */
export const RAW_STORE_SUFFIX: string = names.rawStoreSuffix;
export const PIN_CHARS: number = names.pinChars;
export const RECALL_OUTPUT_CHARS: number = names.recallOutputChars;
/** What /keel puts first in the customInstructions it hands the host. */
export const COMPACT_INSTRUCTION: string = names.compactInstruction;
