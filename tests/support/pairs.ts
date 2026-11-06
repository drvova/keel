// Rendered entries and their messages as the pairs recall loads them, and a search's hits alone.
import type { LoadedEntry } from "../../src/core/load-messages";
import { searchEntries, type SearchHit } from "../../src/core/search-entries";

export const pairs = (entries: readonly any[], messages: readonly any[]): LoadedEntry[] =>
  entries.map((entry, i) => ({ entry, message: messages[i] }));

export const searchHits = (items: readonly LoadedEntry[], query: string): SearchHit[] => searchEntries(items, query).hits;
