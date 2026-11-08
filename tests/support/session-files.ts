// Session files for tests: JSON lines as the hosts write them, in temporary
// directories removed when the process exits.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "keel-sessions-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** LINES written to FILE, one JSON value each; MTIME (seconds) set when given, for tests that list files newest first. */
export const writeJsonl = (file: string, lines: readonly unknown[], mtime?: number): void => {
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (mtime !== undefined) utimesSync(file, mtime, mtime);
};

/** A directory of its own, so no other test's file reads as this project's earlier session. */
export const freshDir = (): string => mkdtempSync(join(root, "p"));

/** ENTRIES as `session.jsonl` in a directory of its own. */
export const sessionFileOfEntries = (entries: readonly unknown[]): { dir: string; file: string } => {
  const dir = freshDir();
  const file = join(dir, "session.jsonl");
  writeJsonl(file, entries);
  return { dir, file };
};

/**
 * Remove DIR, which a just-torn-down session may still hold open: Windows
 * refuses to unlink a file another handle has, and a host's teardown releases
 * it a moment after. rmSync's own retry (maxRetries, retryDelay) settles that;
 * a directory that stays locked is left, since it is a temp dir.
 */
export const removeDir = (dir: string): void => {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {}
};
