import type { NormalizedBlock } from "../types";
import { clip } from "../core/content";
import { SKILL_BLOCK_RE } from "../core/skill-collapse";

/** Each user message becomes one item, clipped to this many characters. */
const USER_MESSAGE_CHARS = 300;
/** [Early Session Requests] keeps this many of the first messages. */
export const EARLY_REQUESTS_KEPT = 3;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Words in any script: Intl.Segmenter splits CJK and Thai too. */
const wordCount = (text: string): number => {
  let n = 0;
  for (const seg of segmenter.segment(text)) if (/[\p{L}\p{N}]/u.test(seg.segment)) n++;
  return n;
};

/**
 * The user's own words in a message, on one line. An expanded skill alone
 * is not the user's words: a skill with text keeps the text behind a
 * `[skill: name]` tag. Text that opens with a tag (`<peer_message …>`,
 * `<local-command-stdout>`) was put there by a tool, and one-word replies
 * ("ok", "好的") say little: both are dropped.
 */
const userLine = (text: string, sourceIndex?: number): string => {
  const skills: string[] = [];
  const rest = text
    .replace(SKILL_BLOCK_RE, (_, name: string) => {
      skills.push(name);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  if (rest.startsWith("<") || wordCount(rest) < 2) return "";
  const line = skills.length > 0 ? `[skill: ${skills.join(", ")}] ${rest}` : rest;
  const clipped = clip(line, USER_MESSAGE_CHARS);
  if (clipped.length === line.length) return line;
  // A cut request reads as complete without a mark, and the cut part can be the
  // constraint that matters: say it goes on, and where vcc_recall reads all of it.
  return `${clipped.trimEnd()}…${sourceIndex != null ? ` (#${sourceIndex})` : ""}`;
};

/**
 * What the user wrote, oldest first, verbatim and clipped (a clipped one ends
 * with `… (#N)`). Messages the
 * user did not write (`injected`) are left out. No wording is interpreted, so this works
 * the same in every language.
 */
export const extractUserMessages = (blocks: NormalizedBlock[]): string[] => {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "user" || b.injected) continue;
    const line = userLine(b.text, b.sourceIndex);
    if (line) lines.push(line);
  }
  return lines;
};
