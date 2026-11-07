// What a command hands the compaction it asks for, and the hook reads back:
// `/omp-vcc keep:N` becomes customInstructions carrying a marker, so the hook
// knows the pass is the command's; `/compact` text may end or start with keep:N
// and carry a prompt to send once it is done. The core reads both
// (lisp/src/args.lisp, op args).
import { core } from "./lisp-core";

/** What /omp-vcc hands the hook for the manual pass it starts; `keep:N` may follow. The core knows it too. */
export const OMP_VCC_COMPACT_INSTRUCTION = "__omp_vcc__";

interface ParsedCompactionArgs {
  followUpPrompt: string;
  /** keep:N as typed; null when none was. */
  keepUserTurns: number | null;
}

/** /omp-vcc's text: the prompt to send after, keep:N, and the customInstructions it hands the host. */
export const commandArgs = (args?: string): ParsedCompactionArgs & { instructions: string } => {
  const reply = core({ op: "args", command: args ?? null });
  return { followUpPrompt: reply.followUpPrompt as string, keepUserTurns: reply.keepUserTurns as number | null, instructions: reply.instructions as string };
};

interface CompactionInstructions {
  /** The pass is /omp-vcc's, which the hook always handles and the command reports. */
  fromCommand: boolean;
  /** keep:N the user typed, always respected; null for the default cut. */
  keepUserTurns: number | null;
  /** /compact's prompt to send once the compaction is done; /omp-vcc sends its own. */
  followUpPrompt: string | null;
}

/** A compaction's customInstructions as the hook reads them. */
export const parseInstructions = (customInstructions?: string): CompactionInstructions => {
  const reply = core({ op: "args", instructions: customInstructions ?? null });
  return { fromCommand: reply.fromCommand === true, keepUserTurns: reply.keepUserTurns as number | null, followUpPrompt: reply.followUpPrompt as string | null };
};
