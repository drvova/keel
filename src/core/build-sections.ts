import type { FileOps, NormalizedBlock } from "../types";
import type { SectionData } from "../sections";
import { extractFiles } from "../extract/files";
import { EARLY_REQUESTS_KEPT, extractUserMessages, keepNewestUserMessages } from "../extract/user-messages";
import { extractCommits, formatCommits } from "../extract/commits";
import { extractTrackedCommands, formatTrackedCommands } from "../extract/tracked-commands";
import { buildBriefSections, stringifyBrief } from "./brief";
import { capItems } from "./format";
import { DEFAULT_SUMMARY_LIMITS, type SummaryLimits } from "./window";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  briefBlocks?: NormalizedBlock[];
  /** Hook-provided file activity; authoritative for files touched before this compaction. */
  fileOps?: FileOps;
  /** Command names to record in a [Tracked Commands] section (see
   * VccSettings.trackCommands). Empty/omitted = section stays empty. */
  trackCommands?: readonly string[];
  /** The previous summary already holds the early requests, so this
   * compaction's first messages are ordinary user messages. */
  hasEarlyRequests?: boolean;
  /**
   * How many early requests this compaction may still add (overrides
   * hasEarlyRequests). The previous summary may hold fewer than
   * EARLY_REQUESTS_KEPT: a first compaction that kept most turns verbatim saw
   * only one or two user messages. Windows are contiguous, so this
   * compaction's first messages are the session's next ones.
   */
  earlyRequestSlots?: number;
  /** Section sizes (core/window.ts); a ~128K window's when omitted. */
  limits?: SummaryLimits;
}

const formatFileActivity = (blocks: NormalizedBlock[], fileOps: FileOps | undefined, filesPerCategory: number): string[] => {
  const act = extractFiles(blocks, fileOps);
  const lines: string[] = [];
  const cap = (set: Set<string>) => capItems([...set], filesPerCategory, ", ");
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read)}`);
  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const limits = input.limits ?? DEFAULT_SUMMARY_LIMITS;
  const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
  // The early requests are the session's first user messages, picked by
  // position; they are not repeated in [User Messages].
  const messages = extractUserMessages(blocks);
  const slots = input.earlyRequestSlots ?? (input.hasEarlyRequests ? 0 : EARLY_REQUESTS_KEPT);
  const early = messages.slice(0, Math.max(0, slots));
  return {
    earlyRequests: early,
    filesAndChanges: formatFileActivity(blocks, input.fileOps, limits.filesPerCategory),
    commits: formatCommits(extractCommits(blocks), limits.commits),
    userMessages: keepNewestUserMessages(messages.slice(early.length), limits.userMessages),
    trackedCommands: formatTrackedCommands(extractTrackedCommands(blocks, input.trackCommands ?? []), limits.commandsPerName),
    briefTranscript: stringifyBrief(briefSections),
  };
};
