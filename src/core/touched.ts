// mode:'touched': the files the session's writes and edits changed, each with
// the entries that changed it, a page at a time.
import type { LoadedEntry } from "./load-messages";
import { outsidePage } from "./format-recall";
import { callKind, filesOf, fileWriteOf, toolCallsOf } from "./tools";

const TOUCHED_PAGE_SIZE = 5;

/** One entry that changed a file. */
interface FileTouch {
  index: number;
  toolName: string;
  /** False when the call names the file but carries no content to drill into (a multi-path or patch edit). */
  drillable?: false;
}

interface TouchedFile {
  path: string;
  entries: FileTouch[];
}

/** The files a message's writes and edits change, each with whether the drill-down can show it (`#N:path`). */
const fileIndicators = (message: unknown): { toolName: string; path: string; drillable: boolean }[] =>
  toolCallsOf(message).flatMap((call) => {
    const kind = callKind(call);
    if (kind !== "write" && kind !== "edit") return [];
    const drillable = fileWriteOf(call) !== undefined;
    return filesOf(call).map((path) => ({ toolName: call.name, path, drillable }));
  });

/** Every file the entries change, first changed first, with the entries that changed it. */
export const touchedFiles = (entries: readonly LoadedEntry[]): TouchedFile[] => {
  const byPath = new Map<string, TouchedFile>();
  for (const { entry, message } of entries) {
    for (const fm of fileIndicators(message)) {
      const file = byPath.get(fm.path) ?? { path: fm.path, entries: [] };
      byPath.set(fm.path, file);
      file.entries.push({ index: entry.index, toolName: fm.toolName, ...(!fm.drillable && { drillable: false as const }) });
    }
  }
  return [...byPath.values()];
};

/** A path as listed: `./…` under the working directory, else its last three parts behind ".../" when it has more. */
const shortPath = (path: string): string => {
  const normalized = path.replace(/\\/g, "/");
  const cwd = process.cwd().replace(/\\/g, "/");
  if (normalized.startsWith(`${cwd}/`)) return `.${normalized.slice(cwd.length)}`;
  const parts = normalized.split("/");
  return parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : normalized;
};

/**
 * A page of touched files, with the next page's call (`next`, the surface's)
 * and a ready `#N:path` call for the first file on it a write or edit can show.
 * `via` is what a follow-up call adds (session:'id' in an earlier session).
 */
export const formatTouched = (touched: readonly TouchedFile[], page: number, hint: { via: string; next: (page: number) => string }): string => {
  if (touched.length === 0) return "No file operations found in session history.";
  const totalPages = Math.ceil(touched.length / TOUCHED_PAGE_SIZE);
  if (page > totalPages) return outsidePage(page, totalPages, `${touched.length} files touched`);
  const { via } = hint;
  const start = (page - 1) * TOUCHED_PAGE_SIZE;
  const files = touched.slice(start, start + TOUCHED_PAGE_SIZE);
  const header = totalPages > 1 ? `Page ${page}/${totalPages} (${touched.length} total files)` : `${touched.length} files touched`;
  const lines = files.map((tf) => `  ${shortPath(tf.path)}    ${tf.entries.map((e) => `#${e.index} (${e.toolName})`).join(", ")}`);
  const next = page < totalPages ? `\n${hint.next(page + 1)}` : "";
  const drill = files
    .map((tf) => ({ tf, write: [...tf.entries].reverse().find((e) => e.drillable !== false) }))
    .find((x) => x.write);
  const drillHint = drill ? `\n--- File content at an entry: query:'#${drill.write!.index}:${drill.tf.path.replace(/\\/g, "/").split("/").pop()}'${via} ---` : "";
  return `${header}:\n\n${lines.join("\n")}${next}${drillHint}`;
};
