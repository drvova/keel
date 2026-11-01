import type { FileOps, NormalizedBlock } from "../types";
import { extractPaths, isUrlPath, stripReadSelector } from "../core/tool-args";

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

// Tool names are matched case-insensitively (see `matches`), mirroring the /i
// regexes in core/rank.ts. Entries must be lowercase.
const FILE_READ_TOOLS = new Set([
  "read", "read_file", "view",
]);

// Multi-file patch tools (apply_patch) carry their paths inside the diff payload,
// not in a path arg, so extractPaths yields nothing for them; those files are
// recovered from the hook-provided fileOps below.
const FILE_WRITE_TOOLS = new Set([
  "edit", "write", "edit_file", "write_file",
  "multiedit", "quick_edit", "target_edit", "apply_patch",
]);

const FILE_CREATE_TOOLS = new Set([
  "write", "write_file",
]);

const matches = (tools: Set<string>, name: string): boolean => tools.has(name.toLowerCase());

/**
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 */
const longestCommonDirPrefix = (paths: string[]): string => {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return ""; // require at least /a/b common
  return split[0].slice(0, i).join("/") + "/";
};

const trimPaths = (set: Set<string>, prefix: string): Set<string> => {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
};

/**
 * Files read, modified and created in these blocks, in order. A `write` to a
 * path not read, edited or written before it here creates the file; one after
 * them rewrites a file that existed. A file created here stays Created when it is
 * edited afterwards: it is still new. omp reports `write`s without saying which
 * kind (`fileOps.writtenFiles`), so one the blocks did not show counts as
 * modified.
 */
export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: FileOps,
): FileActivity => {
  const act: FileActivity = { read: new Set(), modified: new Set(), created: new Set() };
  const seen = new Set<string>();
  const change = (p: string) => {
    if (!act.created.has(p)) act.modified.add(p);
  };

  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    for (const raw of extractPaths(b.args)) {
      if (isUrlPath(raw)) continue;
      if (matches(FILE_READ_TOOLS, b.name)) {
        const p = stripReadSelector(raw);
        act.read.add(p);
        // A read that failed says nothing about the file existing.
        if (!b.failed) seen.add(p);
      } else if (matches(FILE_CREATE_TOOLS, b.name)) {
        if (!b.failed) {
          if (seen.has(raw)) change(raw);
          else act.created.add(raw);
        }
        seen.add(raw);
      } else if (matches(FILE_WRITE_TOOLS, b.name)) {
        change(raw);
        seen.add(raw);
      }
    }
  }

  for (const p of fileOps?.readFiles ?? []) if (!isUrlPath(p)) act.read.add(p);
  for (const p of fileOps?.createdFiles ?? []) if (!isUrlPath(p) && !act.modified.has(p)) act.created.add(p);
  for (const p of [...(fileOps?.modifiedFiles ?? []), ...(fileOps?.writtenFiles ?? [])]) {
    if (!isUrlPath(p)) change(p);
  }

  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
  }

  return act;
};
