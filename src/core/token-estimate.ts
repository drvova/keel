export const DEFAULT_CHARS_PER_TOKEN = 4;
const MIN_CHARS_PER_TOKEN = 2;
const MAX_CHARS_PER_TOKEN = 6;

type TokenEstimateMode = "heuristic" | "calibrated";

interface TokenEstimateCalibration {
  mode: TokenEstimateMode;
  charsPerToken: number;
  sourceChars?: number;
  sourceTokens?: number;
  rawCharsPerToken?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const calibrateCharsPerToken = (
  sourceChars: number,
  sourceTokens: number | undefined,
): TokenEstimateCalibration => {
  if (!sourceTokens || sourceTokens <= 0 || sourceChars <= 0) {
    return { mode: "heuristic", charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  }

  const rawCharsPerToken = sourceChars / sourceTokens;
  if (!Number.isFinite(rawCharsPerToken) || rawCharsPerToken <= 0) {
    return { mode: "heuristic", charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  }

  return {
    mode: "calibrated",
    charsPerToken: clamp(rawCharsPerToken, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN),
    sourceChars,
    sourceTokens,
    rawCharsPerToken,
  };
};

export const estimateTokensFromChars = (
  chars: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number => Math.ceil(chars / charsPerToken);

/**
 * Chars attributed to one image part: the usual agent-harness estimate of
 * about 1200 tokens per image (4800 chars at 4 chars/token).
 */
const IMAGE_CONTENT_CHARS = 4800;

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? "") ?? "";
  } catch {
    return "";
  }
};

/**
 * Estimate the char length of a message's content (string or content-parts
 * array). Counts every token-bearing part the host's token estimate counts, so
 * the calibrated chars/token ratio is not deflated:
 *  - text       → text.length
 *  - thinking   → thinking.length   (opus emits large reasoning blocks)
 *  - toolCall   → name + arguments  (`input` kept for compat)
 *  - image      → IMAGE_CONTENT_CHARS
 *  - toolResult → nested content    (legacy part shape)
 */
export const estimateMessageContentChars = (content: unknown): number => {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part: any) => {
    if (!part || typeof part !== "object") return sum;
    switch (part.type) {
      case "text":
        return sum + (typeof part.text === "string" ? part.text.length : 0);
      case "thinking":
        return sum + (typeof part.thinking === "string" ? part.thinking.length : 0);
      case "toolCall": {
        const args = part.arguments ?? part.input;
        const argLength = typeof args === "string" ? args.length : safeJsonStringify(args).length;
        return sum + (part.name?.length ?? 0) + argLength;
      }
      case "toolResult": {
        const c = part.content;
        return sum + (typeof c === "string" ? c.length : safeJsonStringify(c).length);
      }
      case "image":
        return sum + IMAGE_CONTENT_CHARS;
      default:
        // Unknown part: fall back to any text field so we never undercount.
        return sum + (typeof part.text === "string" ? part.text.length : 0);
    }
  }, 0);
};

/**
 * Chars of one message, whatever its shape. Most roles carry `content`; omp's
 * user-run `!cmd` and python cells, branch and compaction summaries and @file
 * mentions carry their text in other fields, and measured 0 by content alone:
 * a 200k-char `!cmd` output in the kept tail was invisible to the tail budget.
 */
export const estimateMessageChars = (message: unknown): number => {
  if (!message || typeof message !== "object") return 0;
  const m = message as Record<string, unknown>;
  const len = (v: unknown) => (typeof v === "string" ? v.length : 0);
  switch (m.role) {
    case "bashExecution":
      return len(m.command) + len(m.output);
    case "pythonExecution":
      return len(m.code) + len(m.output);
    case "branchSummary":
    case "compactionSummary":
      return len(m.summary);
    case "fileMention":
      return Array.isArray(m.files)
        ? m.files.reduce((sum: number, f: any) => sum + len(f?.path) + len(f?.content) + (f?.image ? IMAGE_CONTENT_CHARS : 0), 0)
        : 0;
    default:
      return estimateMessageContentChars(m.content);
  }
};

export const estimateMessageTokens = (message: unknown, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number =>
  estimateTokensFromChars(estimateMessageChars(message), charsPerToken);

