// Rendered entries and their messages as the pairs recall loads them.
import type { LoadedEntry } from "../../src/core/load-messages";

export const pairs = (entries: readonly any[], messages: readonly any[]): LoadedEntry[] =>
  entries.map((entry, i) => ({ entry, message: messages[i] }));
