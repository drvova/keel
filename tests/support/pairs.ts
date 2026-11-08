// A search over these messages, or a keel_recall call on them, as recall runs
// it: written as a session file and read by the core, each entry's index its #N.
import { join } from "path";
import { core } from "../../src/core";
import { freshDir, writeJsonl } from "./session-files";

export interface SearchHit { index: number; role: string; summary: string; files?: string[]; snippet?: string }
export interface SearchResult { hits: SearchHit[]; totalBeforeCap: number; truncated: boolean; aborted?: string }

let n = 0;

/** A session file of these messages, one entry each on one branch. */
export const sessionFileOf = (messages: readonly unknown[]): string => {
  // A directory of its own: no other test's file reads as this project's earlier session.
  const file = join(freshDir(), `s${++n}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: `session-${n}`, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" },
    ...messages.map((message, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: "2026-01-01T00:00:00.000Z", message })),
  ];
  writeJsonl(file, lines);
  return file;
};

/** The search, with recall's floor and cap unless a test sets its own. */
export const search = (messages: readonly unknown[], query: string, tuning: { relativeFloor?: number; cap?: number } = {}): SearchResult => {
  const reply = core({
    op: "search", query, file: sessionFileOf(messages),
    ...(tuning.relativeFloor !== undefined ? { floor: tuning.relativeFloor } : {}),
    ...(tuning.cap !== undefined ? { cap: Math.min(tuning.cap, 2 ** 31) } : {}),
  });
  return {
    hits: (reply.hits as any[]).map((h) => ({ ...h, snippet: h.snippet ?? undefined })),
    totalBeforeCap: (reply.totalBeforeCap as number | undefined) ?? 0,
    truncated: reply.truncated === true,
    ...(typeof reply.aborted === "string" ? { aborted: reply.aborted } : {}),
  };
};

export const searchHits = (messages: readonly unknown[], query: string): SearchHit[] => search(messages, query).hits;

/** keel_recall on a session of these messages, the session manager on its one branch. */
export const recallOn = (messages: readonly unknown[], params: Record<string, unknown>, options: { contextWindow?: number } = {}): string => {
  const file = sessionFileOf(messages);
  const branch = messages.map((message, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, message }));
  const { executeRecall } = require("./binding") as typeof import("./binding");
  return executeRecall(params, { getSessionFile: () => file, getBranch: () => branch, getEntries: () => branch }, options);
};

/** Each message as recall renders it (op load): its one-line summary, and the full text search reads. */
export const renderedOf = (messages: readonly unknown[]): Array<{ index: number; role: string; summary: string; text: string; files?: string[] }> =>
  core({ op: "load", source: { file: sessionFileOf(messages), ids: null } }).entries as any[];

/** A session file's messages as the core reads them (op load): each one's #N and id, and the message, with what omp rewrote put back. */
export const sessionMessages = (file: string): Array<{ index: number; id?: string; message: any; text: string }> =>
  core({ op: "load", source: { file, ids: null } }).entries as any[];
