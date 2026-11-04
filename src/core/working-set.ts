// [Working Set]: what the next step needs, brought back at a compaction.
//
// A summary says what happened. The agent's next step needs what it was
// working from: the file it is changing, the output of the call that just
// failed. A compaction takes those out of context, and the agent fetches them
// again, a request each (re-exploration after eviction, arXiv:2606.11213; tool
// calls made again after compression as a cost, arXiv:2608.29363). The working
// set brings them back with the compaction, from the originals
// (core/raw-store.ts restores what omp blanked):
//
//   1. the latest version of each file the work is on (touched in the kept
//      tail, named in the latest request, or, when the kept tail has made no
//      call yet, changed in the last summarized turn), unless the kept tail
//      already holds a read or write of it;
//   2. the latest failed call no later call of the same tool and argument
//      fixed, by its end, where errors are;
//   3. the results recall ranks highest for the latest request, a file's
//      latest read only, none of a file the kept tail reads or writes.
//
// Within a budget from compactionBudgets, and never more than half of what the
// compaction removes, so it always frees room. It is rebuilt from the messages at
// every compaction and never carried (the merge with the previous summary
// keeps only the sections it knows), so it stays bounded and is never
// rewritten. Nothing depends on wording: paths, failure flags, recency and
// recall's own ranking.
import type { Message } from "@oh-my-pi/pi-ai";
import { isContentBearing, textOf } from "./content";
import { renderMessage, type RenderedEntry } from "./render-entries";
import { searchEntriesDetailed } from "./search-entries";
import { extractPaths, isUrlPath, stripReadSelector } from "./tool-args";

export interface WorkingSetInput {
  /** What this compaction summarizes, the originals of what omp rewrote put back. */
  summarized: readonly unknown[];
  /** The session-wide #N of each, where known. */
  indices: ReadonlyArray<number | undefined>;
  /** What stays in context after it. */
  kept: readonly unknown[];
  maxChars: number;
}

export type WorkingSetReason = "file" | "failure" | "relevant";

export interface WorkingSetItem {
  index: number;
  reason: WorkingSetReason;
  /** `read "src/a.ts"`, `bash "bun test"`. */
  title: string;
  /** e.g. `the latest version, edited after at #15`. */
  note?: string;
  text: string;
  /** Errors come last in a failed call's output: excerpt its end. */
  fromEnd: boolean;
}

interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
  paths: string[];
  pos: number;
}

interface Result {
  pos: number;
  index: number | undefined;
  call: Call | undefined;
  text: string;
  isError: boolean;
}

/** Below this, an excerpt says too little to bring back. */
const MIN_ITEM_CHARS = 400;
/** One item takes at most this share of the budget, so a big file leaves room for the failure. */
const MAX_ITEM_SHARE = 0.6;
const MAX_RELEVANT = 3;

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

const callsOf = (message: Record<string, any>, pos: number): Call[] =>
  message.role === "assistant" && Array.isArray(message.content)
    ? message.content
        .filter((p: any) => p?.type === "toolCall" && typeof p.id === "string")
        .map((p: any) => {
          const args = asRecord(p.arguments);
          return {
            id: p.id,
            name: typeof p.name === "string" ? p.name : "tool",
            args,
            paths: extractPaths(args).map(stripReadSelector).filter((x) => !isUrlPath(x)),
            pos,
          };
        })
    : [];

/** The argument a call is told apart by: its path, else its command or query. */
const primaryArg = (call: Call): string =>
  call.paths[0] ?? (typeof call.args.command === "string" ? call.args.command : typeof call.args.query === "string" ? call.args.query : "");

const titleOf = (call: Call | undefined): string => {
  if (!call) return "tool result";
  const arg = primaryArg(call);
  return arg ? `${call.name} ${JSON.stringify(arg.length > 80 ? `${arg.slice(0, 80)}…` : arg)}` : call.name;
};

/** A call that writes a file whole: its content is the file. */
const writes = (call: Call): boolean => call.paths.length === 1 && typeof call.args.content === "string";
/** A call that changes part of a file. */
const edits = (call: Call): boolean => !writes(call) && (isContentBearing(call.args) || typeof call.args.input === "string");

const lastUserText = (messages: readonly unknown[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asRecord(messages[i]);
    if (m.role === "user") {
      const text = textOf(m.content);
      if (text.trim()) return text;
    }
  }
  return undefined;
};

export const selectWorkingSet = (input: WorkingSetInput): WorkingSetItem[] => {
  if (!(input.maxChars >= MIN_ITEM_CHARS)) return [];
  const calls = new Map<string, Call>();
  const results: Result[] = [];
  input.summarized.forEach((raw, pos) => {
    const m = asRecord(raw);
    for (const c of callsOf(m, pos)) calls.set(c.id, c);
    if (m.role === "toolResult") {
      results.push({ pos, index: input.indices[pos], call: calls.get(m.toolCallId), text: textOf(m.content), isError: m.isError === true });
    }
  });
  if (results.length === 0) return [];

  const keptCalls = input.kept.flatMap((m, pos) => callsOf(asRecord(m), pos));
  const keptResults = new Map<string, boolean>();
  for (const m of input.kept) {
    const r = asRecord(m);
    if (r.role === "toolResult" && typeof r.toolCallId === "string") keptResults.set(r.toolCallId, r.isError === true);
  }
  const request = lastUserText(input.kept) ?? lastUserText(input.summarized) ?? "";
  const items: WorkingSetItem[] = [];
  const used = new Set<number>();

  // 1. Files the work is on, most recently touched first.
  const lastUserPos = (() => {
    for (let i = input.summarized.length - 1; i >= 0; i--) if (asRecord(input.summarized[i]).role === "user") return i;
    return -1;
  })();
  const allCalls = [...calls.values()];
  const known = new Set(allCalls.flatMap((c) => c.paths));
  const active: string[] = [];
  const add = (p: string) => {
    if (!active.includes(p)) active.push(p);
  };
  for (const c of [...keptCalls].reverse()) c.paths.forEach(add);
  // A kept turn that has not started yet most likely goes on with the last one.
  if (keptCalls.length === 0) for (const c of [...allCalls].reverse()) if (c.pos > lastUserPos && (writes(c) || edits(c))) c.paths.forEach(add);
  for (const p of known) if (request.includes(p)) add(p);
  // Files whose current version the kept tail holds: a read or a write of it is in context already.
  const inContext = new Set(keptCalls.filter((c) => !edits(c)).flatMap((c) => c.paths));
  const chosenPaths = new Set<string>();
  for (const path of active) {
    if (inContext.has(path)) continue;
    const touching = allCalls.filter((c) => c.paths.includes(path)).sort((a, b) => a.pos - b.pos);
    let base: { call: Call; text: string; index: number | undefined } | undefined;
    for (const c of touching) {
      if (writes(c)) base = { call: c, text: String(c.args.content), index: input.indices[c.pos] };
      else if (!edits(c)) {
        const r = results.find((x) => x.call === c);
        if (r && !r.isError && r.text.trim()) base = { call: c, text: r.text, index: r.index };
      }
    }
    if (!base || base.index === undefined || used.has(base.index)) continue;
    const later = touching.filter((c) => c.pos > base!.call.pos && edits(c)).map((c) => input.indices[c.pos]).filter((n): n is number => n !== undefined);
    const keptEdits = keptCalls.some((c) => c.paths.includes(path) && edits(c));
    const edited = later.length > 0 ? `, edited after at ${later.map((n) => `#${n}`).join(", ")}` : keptEdits ? ", edited after in context" : "";
    items.push({ index: base.index, reason: "file", title: titleOf(base.call), note: `the latest version${edited}`, text: base.text, fromEnd: false });
    used.add(base.index);
    chosenPaths.add(path);
  }

  // 2. The latest failure nothing later fixed.
  for (let k = results.length - 1; k >= 0; k--) {
    const r = results[k];
    if (!r.isError || r.index === undefined || used.has(r.index) || !r.text.trim()) continue;
    const key = r.call ? `${r.call.name}\u0000${primaryArg(r.call)}` : undefined;
    const sameLater = (c: Call) => key !== undefined && `${c.name}\u0000${primaryArg(c)}` === key;
    const fixedHere = results.some((x) => x.pos > r.pos && !x.isError && x.call && sameLater(x.call));
    const fixedInKept = keptCalls.some((c) => sameLater(c) && keptResults.get(c.id) === false);
    if (!fixedHere && !fixedInKept) {
      items.push({ index: r.index, reason: "failure", title: `${titleOf(r.call)} [failed]`, note: "its end", text: r.text, fromEnd: true });
      used.add(r.index);
    }
    break;
  }

  // 3. What recall ranks highest for the latest request.
  if (request.trim()) {
    const entries: RenderedEntry[] = [];
    const msgs: Message[] = [];
    // A file's latest read in the summarized part, by position.
    const latestRead = new Map<string, number>();
    for (const r of results) if (r.call && !edits(r.call) && !writes(r.call)) for (const p of r.call.paths) latestRead.set(p, r.pos);
    for (const r of results) {
      if (r.index === undefined || used.has(r.index) || r.isError || !r.text.trim()) continue;
      const paths = r.call?.paths ?? [];
      if (paths.some((p) => inContext.has(p) || chosenPaths.has(p) || latestRead.get(p) !== r.pos)) continue;
      const m = input.summarized[r.pos] as Message;
      entries.push(renderMessage(m, r.index));
      msgs.push(m);
    }
    if (entries.length > 0) {
      const { hits } = searchEntriesDetailed(entries, msgs, request.slice(0, 2_000), { cap: MAX_RELEVANT });
      for (const hit of hits) {
        const r = results.find((x) => x.index === hit.index);
        if (!r || used.has(hit.index)) continue;
        items.push({ index: hit.index, reason: "relevant", title: titleOf(r.call), note: "matches the latest request", text: r.text, fromEnd: false });
        used.add(hit.index);
      }
    }
  }
  return items;
};

/** Lines of `text` that fit `max` chars, from its start or its end, blank lines dropped. */
const excerpt = (text: string, max: number, fromEnd: boolean): { lines: string[]; omitted: number } => {
  const all = text.replace(/\s+$/, "").split("\n").filter((l) => l.trim() !== "");
  const lines: string[] = [];
  let size = 0;
  const order = fromEnd ? [...all].reverse() : all;
  for (const line of order) {
    const clipped = line.length > 300 ? `${line.slice(0, 300)}…` : line;
    if (size + clipped.length + 5 > max) break;
    lines.push(clipped);
    size += clipped.length + 5;
  }
  if (fromEnd) lines.reverse();
  return { lines, omitted: all.length - lines.length };
};

/**
 * The section's lines: one head line per item, its excerpt indented under it.
 * A section has no blank line inside (the summary's sections are told apart by
 * them), and an indented line never reads as a section header or a separator.
 */
export const formatWorkingSet = (items: readonly WorkingSetItem[], maxChars: number): string[] => {
  const lines: string[] = [];
  let left = maxChars;
  for (const item of items) {
    const head = `- #${item.index} ${item.title}${item.note ? `, ${item.note}` : ""}:`;
    const room = Math.min(left - head.length, Math.max(MIN_ITEM_CHARS, Math.round(maxChars * MAX_ITEM_SHARE)));
    if (room < MIN_ITEM_CHARS) break;
    const { lines: body, omitted } = excerpt(item.text, room, item.fromEnd);
    if (body.length === 0) continue;
    const more = omitted > 0 ? `    …[${omitted} more lines: vcc_recall expand:[${item.index}]]` : "";
    const block = [head, ...body.map((l) => `    ${l}`), ...(more ? [more] : [])];
    lines.push(...block);
    left -= block.reduce((n, l) => n + l.length + 1, 0);
  }
  return lines;
};
