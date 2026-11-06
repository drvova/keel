// What a command hands the compaction it asks for, and the hook reads back:
// `/omp-vcc keep:N` becomes customInstructions carrying a marker, so the hook
// knows the pass is the command's; `/compact` text may end or start with keep:N
// and carry a prompt to send once it is done. The Lisp core reads both the same
// way (lisp/src/args.lisp, op args) and answers when there is one.
import { callCore } from "./lisp-core";

/** What /omp-vcc hands the hook for the manual pass it starts; `keep:N` may follow. */
export const OMP_VCC_COMPACT_INSTRUCTION = "__omp_vcc__";

const KEEP_RE = /^keep:(\d+)$/;

interface ParsedCompactionArgs {
  followUpPrompt: string;
  /** keep:N as typed; null when none was. */
  keepUserTurns: number | null;
}

/** keep:N as a number; more digits than a safe integer keeps more turns than any session has. */
const keepOf = (digits: string): number => Math.min(Number(digits), Number.MAX_SAFE_INTEGER);

/** /omp-vcc's text: the prompt to send after, keep:N, and the customInstructions it hands the host. */
export const commandArgs = (args?: string): ParsedCompactionArgs & { instructions: string } => {
  const inCore = callCore({ op: "args", command: args ?? null });
  if (inCore) return { followUpPrompt: inCore.followUpPrompt as string, keepUserTurns: inCore.keepUserTurns as number | null, instructions: inCore.instructions as string };
  const parsed = parseKeepAndPrompt(args);
  return { ...parsed, instructions: buildVccCustomInstructions(parsed.keepUserTurns) };
};

/** A command's arguments: keep:N first or last, the rest a prompt to send after. */
export const parseKeepAndPrompt = (args?: string): ParsedCompactionArgs => {
  const trimmed = args?.trim() ?? "";
  const first = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const firstKeep = first?.[1].match(KEEP_RE);
  if (firstKeep) return { followUpPrompt: (first![2] ?? "").trim(), keepUserTurns: keepOf(firstKeep[1]) };
  const last = trimmed.match(/(?:^|\s)(\S+)$/);
  const lastKeep = last?.[1].match(KEEP_RE);
  if (lastKeep) {
    return { followUpPrompt: trimmed.slice(0, trimmed.length - last![1].length).trim(), keepUserTurns: keepOf(lastKeep[1]) };
  }
  return { followUpPrompt: trimmed, keepUserTurns: null };
};

export const buildVccCustomInstructions = (keepUserTurns: number | null): string =>
  keepUserTurns == null ? OMP_VCC_COMPACT_INSTRUCTION : `${OMP_VCC_COMPACT_INSTRUCTION} keep:${keepUserTurns}`;

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
  const inCore = callCore({ op: "args", instructions: customInstructions ?? null });
  if (inCore) return { fromCommand: inCore.fromCommand === true, keepUserTurns: inCore.keepUserTurns as number | null, followUpPrompt: inCore.followUpPrompt as string | null };
  const trimmed = customInstructions?.trim();
  if (trimmed === OMP_VCC_COMPACT_INSTRUCTION || trimmed?.startsWith(`${OMP_VCC_COMPACT_INSTRUCTION} `)) {
    const parsed = parseKeepAndPrompt(trimmed.slice(OMP_VCC_COMPACT_INSTRUCTION.length));
    return { fromCommand: true, keepUserTurns: parsed.keepUserTurns, followUpPrompt: null };
  }
  const parsed = parseKeepAndPrompt(customInstructions);
  return { fromCommand: false, keepUserTurns: parsed.keepUserTurns, followUpPrompt: parsed.followUpPrompt || null };
};
