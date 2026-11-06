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
 * edited afterwards: it is still new. A write or edit that failed changed
 * nothing. The host's own lists (`fileOps`) fill in only paths the blocks do
 * not show: they come from the same calls with no result read, so a failed one
 * is in them too, and they say a write without saying which kind (a change).
 */
export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: FileOps,
): FileActivity => {
  const act: FileActivity = { read: new Set(), modified: new Set(), created: new Set() };
  const seen = new Set<string>();
  const shown = new Set<string>();
  const change = (p: string) => {
    if (!act.created.has(p)) act.modified.add(p);
  };

  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const kind = callKind(b);
    for (const p of filesOf(b)) {
      shown.add(p);
      if (kind === "read") {
        // A read that failed read nothing, and says nothing about the file existing.
        if (!b.failed) {
          act.read.add(p);
          seen.add(p);
        }
      } else if (kind === "write") {
        if (!b.failed) {
          if (seen.has(p)) change(p);
          else act.created.add(p);
        }
        seen.add(p);
      } else if (kind === "edit") {
        if (!b.failed) change(p);
        seen.add(p);
      }
    }
  }

  for (const p of fileOps?.read ?? []) if (!isUrlPath(p) && !shown.has(p)) act.read.add(p);
  for (const p of fileOps?.changed ?? []) if (!isUrlPath(p) && !shown.has(p)) change(p);

  return act;
};
