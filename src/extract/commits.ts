import type { NormalizedBlock } from "../types";
import { commandOf } from "../core/tools";

interface CommitInfo {
  hash?: string;
  message: string;
}

const COMMIT_MSG_RE = /git\s+commit[^\n]*?\s-[A-Za-z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$?'((?:[^'\\]|\\.)*)')/;
// `-F -` / `--file=-` reads the message from stdin; the heredoc feeding it sits on the same command.
// A file path after -F cannot be read from the transcript, so it is not matched.
const STDIN_HEREDOC_COMMIT_RE =
  /git\s+commit[^\n]*?(?:\s-[A-Za-z]*F|\s--file)(?:\s+|=)-(?=\s)[^\n]*?<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))[^\n]*(?:\r?\n|\\n)/;
// A line that is only a hash, as `git rev-parse --short HEAD` prints it. It
// counts only with a letter in it (hashFromResults checks): a bare number on its
// own line (a count, a random tag) is far more often output of something else.
const LONE_HASH_LINE_RE = /^\s*([0-9a-f]{7,40})\s*$/;

const cleanMessage = (msg: string): string =>
  msg.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();

const linesOf = (text: string): string[] => text.split(/\\n|\n/);

const firstLineOf = (text: string): string => {
  const line = linesOf(text)[0] ?? "";
  return line.trim();
};

// COMMIT_MSG_RE only yields the `$(cat <<...` opener (truncated at the inner quote for <<"DELIM"), so heredoc -m is re-read from the raw command.
const HEREDOC_COMMIT_CMD_RE =
  /^git\s+commit[^\n"'&;|]*?\s-[A-Za-z]*m\s+"\$\(cat\s+<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))(?:\r?\n|\\n)/;

const firstHeredocBodyLine = (rest: string, delim: string): string => {
  for (const line of linesOf(rest)) {
    const trimmed = line.replace(/^\t+/, "").trim();
    if (trimmed === delim) break;
    if (trimmed) return trimmed;
  }
  return "";
};

const subjectFromHeredocCmd = (cmd: string): string | null => {
  const m = cmd.match(HEREDOC_COMMIT_CMD_RE);
  if (!m) return null;
  const delim = m[1] ?? m[2] ?? m[3] ?? "";
  return cleanMessage(firstHeredocBodyLine(cmd.slice(m.index! + m[0].length), delim));
};

const subjectFromStdinHeredoc = (cmd: string): string | null => {
  const m = cmd.match(STDIN_HEREDOC_COMMIT_RE);
  if (!m) return null;
  const delim = m[1] ?? m[2] ?? m[3] ?? "";
  return cleanMessage(firstHeredocBodyLine(cmd.slice(m.index! + m[0].length), delim));
};

// A later `git commit` starts a new commit only at a command boundary, so prose in a message that says "git commit" does not split it.
const COMMIT_START_RE = /\bgit\s+commit\b/g;
const commitSegments = (cmd: string): string[] => {
  const starts: number[] = [];
  for (const m of cmd.matchAll(COMMIT_START_RE)) {
    if (starts.length === 0 || /(?:^|[;&|(\n])\s*$/.test(cmd.slice(0, m.index))) starts.push(m.index!);
  }
  return starts.map((at, k) => cmd.slice(at, starts[k + 1]));
};

/** Subject of the one `git commit ...` in `seg`, or "" when it cannot be read. */
const subjectOf = (seg: string): string => {
  const m = seg.match(COMMIT_MSG_RE);
  if (!m) return subjectFromStdinHeredoc(seg) ?? "";
  // First -m is `"$(cat <<DELIM ...`: COMMIT_MSG_RE only sees `$(cat <<...`, so read the heredoc body.
  const heredoc = m[1] !== undefined && /^\$\(cat\s+<</.test(m[1])
    ? subjectFromHeredocCmd(seg.slice(m.index!))
    : null;
  const message = heredoc ?? firstLineOf(cleanMessage(m[1] ?? m[2] ?? m[3] ?? ""));
  return heredoc === null && /^\$\(cat\s+<</.test(message) ? "" : message;
};

// `[branch <hash>] <subject>` (git commit) or `<hash> [(refs)] <subject>` (git log / git show --oneline).
const HASH_SUBJECT_LINE_RE = /(?:\[[^\]\s]+(?:\s+\([^)]*\))?\s+([0-9a-f]{7,12})\]|^\s*([0-9a-f]{7,12})(?:\s+\([^)]*\))?)\s+(.*)/;
// git commit's own report: `[branch <hash>] <subject>`, also `[branch (root-commit) <hash>]`.
const COMMIT_LINE_RE = /\[[^\]\s]+(?:\s+\([^)]*\))?\s+([0-9a-f]{7,12})\]\s+(.*)/;

const linesOfResults = (results: string[]): string[] => results.flatMap((text) => text.split("\n"));

/** Hash of one commit: only an output line that names its subject counts. */
const hashForSubject = (results: string[], message: string): string | undefined => {
  for (const line of linesOfResults(results)) {
    const m = line.match(HASH_SUBJECT_LINE_RE);
    if (m && m[3].trim() === message) return m[1] ?? m[2];
  }
  return undefined;
};

/** git said it made this commit: its `[branch <hash>] <subject>` line. */
const committedLine = (results: string[], message: string): string | undefined => {
  for (const line of linesOfResults(results)) {
    const m = line.match(COMMIT_LINE_RE);
    if (m && m[2].trim() === message) return m[1];
  }
  return undefined;
};

/**
 * Hash of a lone commit, from git's own output in the next tool results:
 * `git commit`'s `[branch <hash>]` line, a push range, a `--oneline` line naming
 * the subject, or a line that is only a hash. Other hex-looking text (a path, a
 * printed number) is not a hash.
 */
const hashFromResults = (results: string[], message: string): string | undefined => {
  for (const text of results) {
    const bracket = text.match(/\[[^\]\s]+(?:\s+\([^)]*\))?\s+([0-9a-f]{7,12})\]/);
    if (bracket) return bracket[1];
  }
  const named = hashForSubject(results, message);
  if (named) return named;
  for (const text of results) {
    const range = text.match(/\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/);
    if (range) return range[2];
  }
  for (const line of linesOfResults(results)) {
    const lone = line.match(LONE_HASH_LINE_RE);
    if (lone && /[a-f]/.test(lone[1])) return lone[1].slice(0, 12);
  }
  return undefined;
};

/** The (hash, subject) an amend reports: git commit's line or a `--oneline` line. */
const amendedCommit = (results: string[]): { hash: string; message: string } | undefined => {
  for (const line of linesOfResults(results)) {
    const m = line.match(HASH_SUBJECT_LINE_RE);
    if (m && m[3].trim()) return { hash: (m[1] ?? m[2])!, message: m[3].trim() };
  }
  return undefined;
};

/**
 * What a command block printed and whether it failed: a `!cmd`'s own output and
 * exit code, a shell call's results (matched by id, before the next user turn).
 */
const outcomeOf = (blocks: NormalizedBlock[], i: number): { results: string[]; failed: boolean } => {
  const b = blocks[i];
  if (b.kind === "bash") return { results: [b.output], failed: b.exitCode != null && b.exitCode !== 0 };
  const results: string[] = [];
  if (b.kind === "tool_call" && b.id !== undefined) {
    for (let j = i + 1; j < blocks.length && blocks[j].kind !== "user"; j++) {
      const r = blocks[j];
      if (r.kind === "tool_result" && r.callId === b.id) results.push(r.text);
    }
  }
  return { results, failed: b.kind === "tool_call" && b.failed === true };
};

/** Git commits the session made (`git commit -m "..."`), each with the hash its output reported. */
export const extractCommits = (blocks: NormalizedBlock[]): CommitInfo[] => {
  const commits: CommitInfo[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const segments = commitSegments(commandOf(blocks[i]) ?? "");
    if (segments.length === 0) continue;
    const { results, failed } = outcomeOf(blocks, i);

    for (const seg of segments) {
      const amend = /\s--amend\b/.test(seg);
      const message = subjectOf(seg);
      // A failed command made no commit unless git printed that it did (`git commit … && git push` with
      // the push failing): `a && git commit` stops at a failing `a`.
      if (failed && !(message ? committedLine(results, message) : amend && amendedCommit(results))) continue;
      if (amend) {
        // --amend replaces the commit before it, so that commit's hash (and with -m its subject) is gone.
        const reported = message ? undefined : amendedCommit(results);
        const subject = message || reported?.message;
        const hash = message
          ? (segments.length === 1 ? hashFromResults(results, message) : hashForSubject(results, message))
          : reported?.hash;
        const target = [...commits].reverse().find((c) => (!message && subject ? c.message === subject : true));
        if (target && subject) {
          target.message = subject;
          target.hash = hash;
        } else if (target) {
          target.hash = undefined;
        } else if (subject) {
          commits.push({ hash, message: subject });
        }
        continue;
      }
      if (!message) continue;
      // With several commits one output cannot be split reliably, so a hash is taken only when its line names this subject.
      const hash = segments.length === 1 ? hashFromResults(results, message) : hashForSubject(results, message);

      // One entry per commit: the same message seen hashless (`-q` prints no hash) and hashed is one commit, keep the hashed.
      const dup = commits.find((c) => c.message === message && (!c.hash || !hash || c.hash === hash));
      if (!dup) commits.push({ hash, message });
      else if (hash && !dup.hash) dup.hash = hash;
    }
  }

  return commits;
};
