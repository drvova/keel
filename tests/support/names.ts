// keel's names and limits as the core holds them (lisp/src/names.lisp), for
// tests that write them into sessions, instructions and expectations.
import { core } from "../../src/core";

const names = core({ op: "names" }).names as Record<string, any>;

export const PIN_ENTRY_TYPE: string = names.pinEntryType;
export const EVICT_ENTRY_TYPE: string = names.evictEntryType;
export const PIN_CHARS: number = names.pinChars;
export const RECALL_OUTPUT_CHARS: number = names.recallOutputChars;
/** What /keel puts first in the customInstructions it hands the host. */
export const COMPACT_INSTRUCTION: string = names.compactInstruction;
