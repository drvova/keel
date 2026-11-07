// keel's names that only the core uses (lisp/src/names.lisp), as tests
// write them into sessions and instructions: read from the core itself.
import { core } from "../../src/core/lisp-core";

const names = core({ op: "names" }).names as Record<string, string>;

/** The compactor id in a compaction's details; omp-vcc's and pi-vcc's are read as ours. */
export const COMPACTOR = names.compactor;
export const LEGACY_COMPACTORS = names.legacyCompactors as unknown as string[];
/** What /keel puts first in the customInstructions it hands the host. */
export const COMPACT_INSTRUCTION = names.compactInstruction;
