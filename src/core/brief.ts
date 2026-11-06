import type { NormalizedBlock } from "../types";
import { clip } from "./content";
import { callKind, callSubject, isOwnTool, isUnset } from "./tools";
import { collapseSkillText } from "./skill-collapse";
import { PIN_PARAMS, PIN_TOOL, RECALL_PARAMS, RECALL_TOOL } from "../names";
import { pinCallOf } from "./pins";

const TRUNCATE_USER = 256;
const SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS = 120;
const SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS = 120;
const ASSISTANT_HEAD_WORDS = 80;
const ASSISTANT_TAIL_WORDS = 120;

// Strip common self-reflective assistant prefixes that carry no semantic info.
// Conservative list: only removes the leading filler, preserves the actual content.
const SELF_TALK_PREFIX_RE =
  /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;

const isNoiseUser = (text: string): boolean => {
  return !text.trim();
};

// Unicode-aware word segmentation via Intl.Segmenter (built-in, zero dependency)
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Bun's isWordLike is unreliable for alphanumeric tokens. */
const isWord = (seg: { segment: string; isWordLike?: boolean }): boolean =>
  seg.isWordLike || /[\p{L}\p{N}]/u.test(seg.segment);

// Common stop words — don't count toward budget
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no",
  "that", "this", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "who", "which", "what",
  "if", "then", "than", "when", "where", "how", "just", "also",
]);

const normalizeForTokenBudget = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const truncateTokens = (text: string, limit: number): string => {
  const flat = normalizeForTokenBudget(text);
  let count = 0;
  let lastEnd = 0;
  for (const seg of segmenter.segment(flat)) {
    if (isWord(seg)) {
      if (!STOP_WORDS.has(seg.segment.toLowerCase())) {
        count++;
        if (count > limit) {
          return flat.slice(0, lastEnd).trimEnd() + "...(truncated)";
        }
      }
    }
    lastEnd = seg.index + seg.segment.length;
  }
  return flat;
};

const significantWordSpans = (flat: string): { start: number; end: number }[] => {
  const words: { start: number; end: number }[] = [];
  for (const seg of segmenter.segment(flat)) {
    if (!isWord(seg)) continue;
    if (STOP_WORDS.has(seg.segment.toLowerCase())) continue;
    words.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  return words;
};


const truncateTokensHeadTail = (text: string, headLimit: number, tailLimit: number): string => {
  const flat = normalizeForTokenBudget(text);
  if (headLimit <= 0 || tailLimit <= 0) return flat;
  const words = significantWordSpans(flat);
  if (words.length <= headLimit + tailLimit) return flat;
  const head = flat.slice(0, words[headLimit - 1].end).trimEnd();
  const tail = flat.slice(words[words.length - tailLimit].start).trimStart();
  return `${head}\n...(middle truncated)...\n${tail}`;
};

const nextRenderableBlock = (blocks: NormalizedBlock[], index: number): NormalizedBlock | undefined => {
  for (let i = index + 1; i < blocks.length; i++) {
    if (blocks[i].kind !== "tool_result") return blocks[i];
  }
  return undefined;
};

const isSegmentClosingAssistant = (blocks: NormalizedBlock[], index: number): boolean => {
  if (blocks[index]?.kind !== "assistant") return false;
  const next = nextRenderableBlock(blocks, index);
  return !next || next.kind === "user";
};

const BASH_CAP = 240;
const PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\s[^|]*)?$/;
// Preamble/boilerplate lines that carry no durable fact on their own. Dropped
// when a script has more informative lines, so `set -euo pipefail\ngit commit`
// renders the commit rather than the shell option.
export const TRIVIAL_LINE_RE = /^(?:set\s+[-+]|cd\s+\S+$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#)/;
// A real heredoc opener: `<<` at a command boundary — not preceded by a word
// char or `)`, so shift ops (`8 << 20`, `Rd<<8`) are not misread — with an
// identifier terminator starting [A-Za-z_], so numeric `<< 10` is rejected too.
const HEREDOC_OPEN_RE = /(?<![\w)])<<-?\s*["']?([A-Za-z_]\w*)["']?/;
// File-writer heredocs (`cat > f <<EOF`, tee, dd) already name their target, so
// the opener alone is informative → body-only. EVERY other heredoc has a
// content-free opener (interpreters python3/node, remote shells `ssh host <<CMD`,
// sqlite3, ...) → we surface a one-line body preview. This denylist replaces an
// interpreter allowlist that missed ssh/sqlite3/etc. and mis-handled heredocs
// combined with a `>` redirect.
const FILEWRITER_HEREDOC_RE = /(?:^|[|&;]\s*)(?:cat|tee|dd)\b/;
const HEREDOC_BODY_CAP = 80;
// Body lines that are pure boilerplate and make a poor preview.
const BODY_NOISE_RE = /^(?:import\s|from\s+\S+\s+import|require\(|const\s+\w+\s*=\s*require|#|\/\/|"""|'''|"use strict"|use\s+strict|<\?php)/;

/**
 * If `lines[i]` opens a heredoc whose terminator actually appears on a later
 * line, return that terminator's line index; otherwise -1. Callers use -1 to
 * leave following lines intact instead of treating a stray `<<` (a shift op, a
 * quoted string, or a truncated body) as a heredoc and skipping real commands.
 */
export const heredocCloseIndex = (lines: string[], i: number): number => {
  const hd = lines[i].match(HEREDOC_OPEN_RE);
  if (!hd) return -1;
  const term = hd[1];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === term) return j;
  }
  return -1;
};

const stripCdPrefix = (line: string): string => line.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
const stripPipeTail = (line: string): string => {
  let c = line;
  for (let i = 0; i < 3; i++) {
    const stripped = c.replace(PIPE_TAIL_RE, "");
    if (stripped === c) break;
    c = stripped;
  }
  return c.trim();
};

/**
 * Semantic compression of a (possibly multi-line) bash command.
 * 1. Drop heredoc BODIES (keep the opener line, e.g. `cat > f <<EOF` or
 *    `python3 - <<PY`): the body is prose/script content that bloats the brief
 *    without adding countable facts, while the opener still records what ran.
 * 2. Drop trivial preamble lines (set -euo pipefail, cd-only, export, source,
 *    comments) unless they are the ONLY line, so real work below them surfaces.
 * 3. Strip `cd <path> &&` prefixes and pipe-tail formatting per line.
 * 4. Join the remaining meaningful lines with `; ` and cap length.
 */
const compressBash = (raw: string): string => {
  // Pass 1: keep heredoc opener lines, skip their bodies + terminators.
  const rawLines = raw.split("\n");
  const withoutHeredocBodies: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    withoutHeredocBodies.push(line);
    // Only treat this as a heredoc when its terminator appears downstream; a
    // stray `<<` (string/expression or truncated body) leaves later lines intact.
    const close = heredocCloseIndex(rawLines, i);
    if (close === -1) continue;
    // File-writer heredocs (`cat > f <<EOF`) name their target → keep opener only.
    // Every other heredoc has a content-free opener → grab the first meaningful
    // body line as a preview (`python3 - <<PY`, `ssh host <<CMD`, `sqlite3 <<SQL`).
    const wantPreview = !FILEWRITER_HEREDOC_RE.test(line);
    let preview = "";
    for (let j = i + 1; wantPreview && !preview && j < close; j++) {
      const t = rawLines[j].trim();
      if (t && !BODY_NOISE_RE.test(t)) preview = t;
    }
    if (preview) {
      const clipped = preview.length > HEREDOC_BODY_CAP ? preview.slice(0, HEREDOC_BODY_CAP - 1) + "\u2026" : preview;
      withoutHeredocBodies[withoutHeredocBodies.length - 1] = `${line.trim()} ${clipped}`;
    }
    i = close; // for-loop's i++ then skips past the terminator line
  }

  const lines = withoutHeredocBodies.map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return raw.trim();

  const meaningful = lines
    .filter(l => !TRIVIAL_LINE_RE.test(l))
    .map(l => stripPipeTail(stripCdPrefix(l)))
    .filter(Boolean);
  // If everything was trivial (e.g. a bare `set -e` or `cd dir`), fall back to
  // the first line so the marker is never empty.
  const chosen = meaningful.length ? meaningful : [stripPipeTail(stripCdPrefix(lines[0]))].filter(Boolean);

  const cmd = chosen.join("; ");
  if (cmd.length > BASH_CAP) {
    return cmd.slice(0, BASH_CAP - 3) + "...";
  }
  return cmd;
};

/** A python cell as one line: its non-blank lines joined with `; `, capped like a bash command. */
const compressCode = (raw: string): string => {
  const cmd = raw.split("\n").map((l) => l.trim()).filter(Boolean).join("; ");
  return cmd.length > BASH_CAP ? cmd.slice(0, BASH_CAP - 3) + "..." : cmd;
};

/** A recall arg as the agent would write it again: `[1, 25]`, `sessions`. */
const recallArg = (value: unknown): string =>
  Array.isArray(value) ? `[${value.join(", ")}]` : clip(String(value).trim(), 40);

/**
 * omp-vcc's own tools: what was recalled or pinned, not a bare `* vcc_recall`.
 * A call reading `mode:sessions`, `expand:[1, 25]` or `session:'id'` says which
 * history the agent already went back to.
 */
const vccToolLine = (name: string, args: Record<string, unknown>): string | undefined => {
  if (isOwnTool(name, RECALL_TOOL)) {
    const parts: string[] = [];
    if (typeof args.query === "string" && args.query.trim()) parts.push(`"${clip(args.query, 60)}"`);
    // Every param the tool takes, so a page-2 call is not merged with page 1 as `x2`.
    for (const key of RECALL_PARAMS) {
      const value = args[key];
      if (key === "query" || isUnset(value)) continue;
      if (key === "page" && Number(value) === 1) continue;
      parts.push(`${key}:${recallArg(value)}`);
    }
    return parts.length > 0 ? `* ${name} ${parts.join(" ")}` : `* ${name}`;
  }
  if (isOwnTool(name, PIN_TOOL)) {
    // As the tool ran it: a call with both was refused, and pinned nothing.
    const call = pinCallOf(args);
    if ("note" in call) return `* ${name} "${clip(call.note, 60)}"`;
    if ("unpin" in call) return `* ${name} ${PIN_PARAMS.unpin}:${recallArg(call.unpin)}`;
    return `* ${name}`;
  }
  return undefined;
};

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
  const own = vccToolLine(name, args);
  if (own) return own;
  const subject = callSubject({ name, args });
  if (!subject) return `* ${name}`;
  if (callKind({ name, args }) === "shell") return `* ${name} "${compressBash(subject.value)}"`;
  const value = subject.label === "query" ? clip(subject.value, 60) : subject.value;
  return `* ${name} "${value}"${subject.more ? ` +${subject.more}` : ""}`;
};

/**
 * A line of the brief: text (a ref already in it), a tool call with the `#N`
 * of every consecutive identical call, or the count of a turn's calls left out.
 */
type BriefItem = { text: string } | { call: string; refs: number[] } | { omitted: number };

interface BriefLine {
  /** Section header like "[user]" or "[assistant]" */
  header: string;
  lines: BriefItem[];
}

const isToolItem = (item: BriefItem): boolean => !("text" in item);

const renderItem = (item: BriefItem): string => {
  if ("text" in item) return item.text;
  if ("omitted" in item) return `* (${item.omitted} earlier tool-call entries omitted)`;
  const refs = item.refs.map((r) => `#${r}`).join(", ");
  if (item.refs.length === 0) return item.call;
  return item.refs.length === 1 ? `${item.call} (${refs})` : `${item.call} (${refs}) x${item.refs.length}`;
};

/** Cap tool calls per [assistant] turn, keeping the tail: the latest actions tend to be the deciding edits and writes, the head exploration. */
const TOOL_CALLS_PER_TURN = 8;

export const buildBriefSections = (blocks: NormalizedBlock[]): BriefLine[] => {
  const sections: BriefLine[] = [];
  let lastHeader = "";

  const push = (header: string, item: BriefItem) => {
    if (header === lastHeader && sections.length > 0) {
      const lines = sections[sections.length - 1].lines;
      const last = lines[lines.length - 1];
      // Consecutive identical calls are one line with every #N; a ref-less call never joins one.
      if ("call" in item && item.refs.length > 0 && last && "call" in last && last.refs.length > 0 && last.call === item.call) {
        last.refs.push(...item.refs);
        return;
      }
      lines.push(item);
      return;
    }
    sections.push({ header, lines: [item] });
    lastHeader = header;
  };

  const pushText = (header: string, text: string, ref = "") => {
    const lines = text.split("\n");
    if (ref && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}${ref}`;
    }
    for (const line of lines) push(header, { text: line });
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const b = blocks[blockIndex];
    switch (b.kind) {
      case "user": {
        if (isNoiseUser(b.text)) break;
        const text = truncateTokens(collapseSkillText(b.text), TRUNCATE_USER);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          pushText("[user]", text, ref);
        }
        lastHeader = "[user]";
        break;
      }
      case "bash": {
        const cmd = b.lang === "python" ? compressCode(b.command) : compressBash(b.command);
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        if (cmd) {
          const failed = b.exitCode != null && b.exitCode !== 0 ? " [failed]" : "";
          push("[user]", { text: `${b.lang === "python" ? ">>>" : "$"} ${cmd}${failed}${ref}` });
        }
        lastHeader = "[user]";
        break;
      }
      case "assistant": {
        let raw = b.text;
        // Strip leading self-talk prefix (up to 2x; assistants sometimes chain "Hmm, actually, ...")
        for (let i = 0; i < 2; i++) {
          const stripped = raw.replace(SELF_TALK_PREFIX_RE, "");
          if (stripped === raw) break;
          raw = stripped;
        }
        const text = isSegmentClosingAssistant(blocks, blockIndex)
          ? truncateTokensHeadTail(raw, SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS, SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS)
          : truncateTokensHeadTail(raw, ASSISTANT_HEAD_WORDS, ASSISTANT_TAIL_WORDS);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          pushText("[assistant]", text, ref);
        }
        break;
      }
      case "tool_call": {
        // Skip malformed tool calls from streaming providers (empty name / fragmented args).
        if (!b.name || b.name.trim() === "") break;
        const call = toolOneLiner(b.name, b.args) + (b.failed ? " [failed]" : "");
        push("[assistant]", { call, refs: b.sourceIndex != null ? [b.sourceIndex] : [] });
        break;
      }
      case "tool_result":
        // Tool result bodies are intentionally omitted from compact briefs.
        break;
    }
  }

  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const calls = sec.lines.filter(isToolItem);
    if (calls.length <= TOOL_CALLS_PER_TURN) continue;
    const dropped = new Set(calls.slice(0, calls.length - TOOL_CALLS_PER_TURN));
    const firstKept = calls[calls.length - TOOL_CALLS_PER_TURN];
    sec.lines = sec.lines.flatMap((item) =>
      dropped.has(item) ? [] : item === firstKept ? [{ omitted: dropped.size }, item] : [item]);
  }

  return sections;
};

export const stringifyBrief = (sections: BriefLine[]): string => {
  // No blank line between consecutive sections of tool calls only.
  const out: string[] = [];
  const toolsOnly = (sec: BriefLine) => sec.header === "[assistant]" && sec.lines.every(isToolItem);
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (i > 0 && !(toolsOnly(sections[i - 1]) && toolsOnly(sec))) out.push("");
    out.push(sec.header);
    for (const item of sec.lines) out.push(renderItem(item));
  }
  return out.join("\n");
};

export const compileBrief = (blocks: NormalizedBlock[]): string =>
  stringifyBrief(buildBriefSections(blocks));
