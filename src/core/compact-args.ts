// What /omp-vcc hands the compaction it asks for: `/omp-vcc keep:N` becomes
// customInstructions carrying a marker, so the hook (the core, reading the
// event) knows the pass is the command's; the rest is a prompt to send once it
// is done (lisp/src/args.lisp, op args).
import { core } from "./lisp-core";

interface ParsedCompactionArgs {
  followUpPrompt: string;
  /** keep:N as typed; null when none was. */
}

/** /omp-vcc's text: the prompt to send after, keep:N, and the customInstructions it hands the host. */
export const commandArgs = (args?: string): ParsedCompactionArgs & { instructions: string } => {
  const reply = core({ op: "args", command: args ?? null });
  return { followUpPrompt: reply.followUpPrompt as string, instructions: reply.instructions as string };
};
