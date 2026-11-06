import type { FileOps, NormalizedBlock } from "../types";
import { callKind, filesOf, isUrlPath } from "../core/tools";

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

/**
 * Files read, modified and created in these blocks, in order. A `write` to a
 * path not read, edited or written before it here creates the file; one after
 * them rewrites a file that existed. A file created here stays Created when it is
 * edited afterwards: it is still new. The host reports writes without saying
 * which kind (`fileOps.changed`), so one the blocks did not show counts as
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
    const kind = callKind(b);
    for (const p of filesOf(b)) {
      if (kind === "read") {
        act.read.add(p);
        // A read that failed says nothing about the file existing.
        if (!b.failed) seen.add(p);
      } else if (kind === "write") {
        if (!b.failed) {
          if (seen.has(p)) change(p);
          else act.created.add(p);
        }
        seen.add(p);
      } else if (kind === "edit") {
        change(p);
        seen.add(p);
      }
    }
  }

  for (const p of fileOps?.read ?? []) if (!isUrlPath(p)) act.read.add(p);
  for (const p of fileOps?.changed ?? []) if (!isUrlPath(p)) change(p);

  return act;
};
