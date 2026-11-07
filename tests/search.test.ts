// Recall's search (lisp/src/search.lisp): terms ranked by BM25 with stems and
// a relative floor, or a regex, over each message as recall renders it.
import { search, searchHits } from "./support/pairs";
import { describe, it, expect } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";

/** What recall listed of an entry, which the search no longer reads: kept so each case still says what it is. */
type RenderedEntry = { index: number; role: string; summary: string; files?: string[] };

const entries: RenderedEntry[] = [
  { index: 0, role: "user", summary: "Fix login bug" },
  { index: 1, role: "assistant", summary: "Reading auth.ts" },
  { index: 2, role: "tool_result", summary: "[Read] code here" },
  { index: 3, role: "assistant", summary: "Found the root cause in auth module" },
];

const messages: Message[] = [
  { role: "user", content: "Fix login bug" } as any,
  { role: "assistant", content: [{ type: "text", text: "Reading auth.ts" }] } as any,
  { role: "toolResult", content: [{ type: "text", text: "[Read] code here" }] } as any,
  { role: "assistant", content: [{ type: "text", text: "Found the root cause in auth module" }] } as any,
];

describe("search", () => {
  it("finds nothing for an empty query", () => {
    expect(searchHits(messages, "  ")).toEqual([]);
  });

  it("filters by single term", () => {
    const r = searchHits(messages, "login");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("returns empty for no match", () => {
    expect(searchHits(messages, "xyz123")).toEqual([]);
  });

  it("finds keyword beyond clip boundary in full content", () => {
    const longText = "A".repeat(400) + " hidden_keyword here";
    const longEntries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "A".repeat(300) },
    ];
    const longMsgs: Message[] = [
      { role: "user", content: longText } as any,
    ];
    const r = searchHits(longMsgs, "hidden_keyword");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("hidden_keyword");
  });

  // ── regex support ──

  it("supports regex pattern: alternation", () => {
    const r = searchHits(messages, "login|auth");
    expect(r).toHaveLength(3); // "login bug", "auth.ts", "auth module"
    expect(r.map((h) => h.index).sort()).toEqual([0, 1, 3]);
  });

  it("supports regex pattern: wildcard", () => {
    const r = searchHits(messages, "Read.*auth");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(1);
  });

  it("falls back to escaped literal for invalid regex", () => {
    const extraEntries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "test (foo" },
      { index: 1, role: "assistant", summary: "no match here" },
    ];
    const extraMsgs: Message[] = [
      { role: "user", content: "error with (foo pattern" } as any,
      { role: "assistant", content: [{ type: "text", text: "no match here" }] } as any,
    ];
    const r = searchHits(extraMsgs, "(foo");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("regex is case-insensitive", () => {
    const r = searchHits(messages, "FIX|ROOT");
    expect(r).toHaveLength(2);
  });

  // ── natural language queries (OR logic + ranking) ──

  it("natural language query uses OR logic", () => {
    // "root cause auth" -- matches entries containing ANY of these terms
    const r = searchHits(messages, "root cause auth");
    expect(r.length).toBeGreaterThanOrEqual(2); // #3 has all 3, #1 has auth
    // Best match (highest BM25) should come first
    expect(r[0].index).toBe(3); // "Found the root cause in auth module" matches all 3
  });

  it("filters stopwords from queries", () => {
    // Searches login and bug; searching "the" as well would also match #3.
    const r = searchHits(messages, "what is the login bug");
    expect(r.map((h) => h.index)).toEqual([0]);
  });

  it("keeps all terms if all are stopwords", () => {
    // When all terms are stopwords, keep them (don't drop everything)
    // "the" appears in "Found the root cause" so it matches
    const r = searchHits(messages, "the");
    expect(r.length).toBeGreaterThan(0);
  });

  // ── line-based snippet ──

  it("snippet shows context lines around match", () => {
    const multiline = "line 0\nline 1\nline 2 TARGET\nline 3\nline 4\nline 5";
    const e: RenderedEntry[] = [{ index: 0, role: "user", summary: "test" }];
    const m: Message[] = [{ role: "user", content: multiline } as any];
    const r = searchHits(m, "TARGET");
    expect(r).toHaveLength(1);
    const snip = r[0].snippet!;
    expect(snip).toContain("line 2 TARGET");
    expect(snip).toContain("line 0");
    expect(snip).toContain("line 4");
    expect(snip).not.toContain("line 5");
  });

  it("snippet handles match at beginning", () => {
    const multiline = "TARGET here\nline 1\nline 2\nline 3";
    const e: RenderedEntry[] = [{ index: 0, role: "user", summary: "test" }];
    const m: Message[] = [{ role: "user", content: multiline } as any];
    const r = searchHits(m, "TARGET");
    const snip = r[0].snippet!;
    expect(snip).toContain("TARGET here");
    expect(snip).toContain("line 2");
    expect(snip).not.toContain("line 3");
  });
});

describe("search regex safety", () => {
  const corpus = (n: number) => {
    const entries: any[] = [];
    const messages: any[] = [];
    for (let i = 0; i < n; i++) {
      const body = "a".repeat(40) + "b";
      entries.push({ index: i, role: "user", summary: body, files: [] });
      messages.push({ role: "user", content: [{ type: "text", text: body }] });
    }
    return { entries, messages };
  };

  it("treats nested-quantifier patterns as literals instead of hanging", () => {
    const { entries, messages } = corpus(20);
    const text = "the pattern (a+)+$ backtracks";
    entries.push({ index: 20, role: "user", summary: text, files: [] });
    messages.push({ role: "user", content: [{ type: "text", text }] });
    // As a pattern it matches none of these, and the backtracking runs the search out of its time budget.
    const r = search(messages, "(a+)+$");
    expect(r.aborted).toBeUndefined();
    expect(r.hits.map((h) => h.index)).toEqual([20]);
  });

  it("still honours legitimate regex queries", () => {
    const entries: any[] = [
      { index: 0, role: "user", summary: "deploy to staging", files: [] },
      { index: 1, role: "user", summary: "deploy to prod", files: [] },
    ];
    const messages: any[] = entries.map((e) => ({
      role: "user",
      content: [{ type: "text", text: e.summary }],
    }));
    const hits = searchHits(messages, "stag(ing|e)");
    expect(hits.length).toBe(1);
    expect(hits[0].index).toBe(0);
  });
});

describe("search mode fallback", () => {
  const texts = [
    "We decided to drop the Redis cache because invalidation kept breaking staging.",
    "The auth flow now uses short-lived tokens refreshed by the gateway.",
    "Ran the migration script; it failed on the users table and we rolled back.",
  ];
  const entries: any[] = texts.map((t, i) => ({ index: i, role: "user", summary: t, files: [] }));
  const messages: any[] = texts.map((t) => ({ role: "user", content: [{ type: "text", text: t }] }));

  it("falls back to term search when punctuation forces the regex path", () => {
    // A trailing "?" makes looksLikeRegex treat the whole sentence as one pattern.
    expect(searchHits(messages, "why did we drop the cache?").length)
      .toBe(searchHits(messages, "why did we drop the cache").length);
  });

  it("keeps regex results when the pattern actually matches", () => {
    // Term search would rank the short, repeated mention first; regex hits stay in session order.
    const texts = ["the cache came up once in a long note about deploys, staging and the gateway", "cache cache"];
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));
    expect(searchHits(m, "cache|redis").map((h) => h.index)).toEqual([0, 1]);
  });
});

describe("search toolCall arguments", () => {
  it("finds a command, written content or edit text that exists only in toolCall arguments", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["bash", { command: "grep -rn UNIQUEMARKER42 src" }, "UNIQUEMARKER42"],
      ["Write", { path: "config.json", content: '{ "featureFlag": "ZEBRA_STRIPE_MODE" }' }, "ZEBRA_STRIPE_MODE"],
      ["Edit", { path: "a.ts", oldText: "const x = 1;", newText: "const QUOKKA_TOKEN = 2;" }, "QUOKKA_TOKEN"],
    ];
    for (const [name, args, needle] of cases) {
      const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Working on it" }];
      const m: Message[] = [{ role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } as any];
      const r = searchHits(m, needle);
      expect(r.map((h) => h.index)).toEqual([0]);
      expect(r[0].snippet).toContain(needle);
    }
  });

  it("finds edits[] array oldText/newText that exist only in toolCall arguments", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Editing file" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{
        type: "toolCall", name: "Edit",
        arguments: { path: "a.ts", edits: [{ oldText: "old", newText: "const NARWHAL_FLAG = true;" }] },
      }],
    } as any];
    const r = searchHits(m, "NARWHAL_FLAG");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("NARWHAL_FLAG");
  });

  it("does not index a toolCall argument past the aggregate message budget (head-only cap)", () => {
    // Needle sits ~5000 chars into a single arg field, well past the ~2000-char
    // per-message toolCall-args budget — it must not be indexed.
    const giant = "A".repeat(5000) + " NEEDLE_PAST_THE_CAP";
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Writing large file" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "Write", arguments: { content: giant } }],
    } as any];
    expect(searchHits(m, "NEEDLE_PAST_THE_CAP")).toHaveLength(0);
  });

  it("aggregates multiple toolCalls under ONE message-level budget, not per-call", () => {
    // Two toolCalls, each individually well under a 2000-char cap (~1500
    // chars), so a *per-call* cap would let both through in full. Only an
    // *aggregate* per-message budget clips the combined text — proving the
    // fix for the reviewed invariant (N toolCalls must not multiply the bound).
    const call1 = { command: "EARLY_MARKER " + "A".repeat(1490) }; // ~1503 chars
    const call2 = { command: "B".repeat(1490) + " LATE_MARKER_XYZ" }; // ~1507 chars
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Two big bash calls" }];
    const m: Message[] = [{
      role: "assistant",
      content: [
        { type: "toolCall", name: "bash", arguments: call1 },
        { type: "toolCall", name: "bash", arguments: call2 },
      ],
    } as any];
    const early = searchHits(m, "EARLY_MARKER");
    expect(early).toHaveLength(1);
    expect(early[0].snippet).toContain("EARLY_MARKER");
    // Combined raw text (call1 + "\n" + call2) is ~3011 chars; LATE_MARKER_XYZ
    // sits at the tail of call2, past the shared 2000-char budget.
    expect(searchHits(m, "LATE_MARKER_XYZ")).toHaveLength(0);
  });

  it("excludes the recall tool's own arguments from search (no self-hit)", () => {
    // A vcc_recall invocation is persisted as an ordinary assistant toolCall.
    // Its own { query } argument must not echo the search term back as a
    // guaranteed self-hit — that would pollute every search's result count.
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Searching" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "vcc_recall", arguments: { query: "SELF_HIT_MARKER" } }],
    } as any];
    expect(searchHits(m, "SELF_HIT_MARKER")).toHaveLength(0);
  });

  it("excludes only the recall tool call, not a sibling toolCall in the same message", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Searching then running" }];
    const m: Message[] = [{
      role: "assistant",
      content: [
        { type: "toolCall", name: "vcc_recall", arguments: { query: "SELF_HIT_MARKER" } },
        { type: "toolCall", name: "bash", arguments: { command: "echo SIBLING_MARKER" } },
      ],
    } as any];
    expect(searchHits(m, "SELF_HIT_MARKER")).toHaveLength(0);
    const r = searchHits(m, "SIBLING_MARKER");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("SIBLING_MARKER");
  });

  it("excludes the recall tool call case-insensitively", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Searching" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "VCC_Recall", arguments: { query: "SELF_HIT_MARKER_2" } }],
    } as any];
    expect(searchHits(m, "SELF_HIT_MARKER_2")).toHaveLength(0);
  });
});

describe("search recall toolResult exclusion", () => {
  // A vcc_recall call is [toolCall args (assistant)] -> [toolResult text].
  // The toolCall-args side is covered above; these cover the toolResult side
  // — its "N matches for \"<query>\">" text must not self-match a repeat query.

  it("excludes the recall tool's own toolResult from search (no growth on repeat query)", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "tool_result", summary: '[vcc_recall] 1 matches for "MARKER"' }];
    const m: Message[] = [{
      role: "toolResult", toolName: "vcc_recall",
      content: [{ type: "text", text: '1 matches for "MARKER" (page 1/1)' }],
    } as any];
    expect(searchHits(m, "MARKER")).toHaveLength(0);
  });

  it("keeps an ordinary (non-recall) toolResult searchable", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "tool_result", summary: "[Read] file contents" }];
    const m: Message[] = [{
      role: "toolResult", toolName: "Read",
      content: [{ type: "text", text: "export const MARKER_VALUE = 1;" }],
    } as any];
    const r = searchHits(m, "MARKER_VALUE");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("MARKER_VALUE");
  });

  it("excludes the recall toolResult case-insensitively", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "tool_result", summary: '[VCC_Recall] 1 matches for "MARKER2"' }];
    const m: Message[] = [{
      role: "toolResult", toolName: "VCC_Recall",
      content: [{ type: "text", text: '1 matches for "MARKER2"' }],
    } as any];
    expect(searchHits(m, "MARKER2")).toHaveLength(0);
  });
});

describe("search relative noise floor", () => {
  // Query matches all 4 terms multiple times in entry 0, all 4 terms once
  // in entry 1, and only 1 of 4 terms once each in entries 2-4 — a clear
  // score cliff between {0,1} and {2,3,4} under multi-term BM25 OR scoring.
  const graded = [
    "alpha beta gamma delta alpha beta gamma delta alpha beta gamma delta discussion of the redis cache design",
    "alpha beta gamma delta talked about this pairing once in a design review",
    "alpha mentioned once in passing during a long unrelated conversation about something else entirely",
    "beta appears here only one time in a sentence about nothing important at all today",
    "gamma shows up once too in this otherwise unrelated paragraph of text about weather",
  ];
  const gradedEntries: RenderedEntry[] = graded.map((t, i) => ({ index: i, role: "user", summary: t }));
  const gradedMessages: Message[] = graded.map((t) => ({ role: "user", content: t } as any));
  const query = "alpha beta gamma delta";

  it("drops a clearly low-score tail but preserves the surviving hits' order (default floor)", () => {
    // Baseline (floor disabled): every entry matches at least one term.
    const baseline = search(gradedMessages, query, { relativeFloor: 0, cap: 1e9 });
    expect(baseline.hits.map((h) => h.index)).toEqual([0, 1, 2, 4, 3]);

    // Default floor (no tuning override — the real production constant):
    // the low-score tail (2, 3, 4) is dropped, top order (0, 1) preserved.
    const r = search(gradedMessages, query);
    expect(r.hits.map((h) => h.index)).toEqual([0, 1]);
    expect(r.totalBeforeCap).toBe(2);
    expect(r.truncated).toBe(false); // floor-filtered, not cap-truncated
  });

  it("never zeroes a non-empty result — a sole, low-score hit still survives", () => {
    const texts = ["nothing relevant here at all", "the redis cache invalidation kept failing in staging"];
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));
    const r = search(m, "redis cache invalidation");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].index).toBe(1);
  });

  it("never applies the relative floor to single-term queries — structural, not fixture-specific", () => {
    // Effective term count (after stopword filtering) gates the floor: <2
    // terms skips it entirely, regardless of how aggressive the floor is.
    // Proven with an aggressive floor override (0.9) and a corpus shaped so
    // the low-scoring hit WOULD be cut if the floor applied — it survives
    // only because the single-term gate bypasses filtering altogether.
    const singleTermTexts = [
      "auth ".repeat(20) + "flow rewritten", // 20x occurrences — high score
      "one mention of auth here in an otherwise unrelated changelog entry", // 1x — low score
    ];
    const e: RenderedEntry[] = singleTermTexts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = singleTermTexts.map((t) => ({ role: "user", content: t } as any));
    const r = search(m, "auth", { relativeFloor: 0.9, cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0, 1]); // both survive: gate bypassed floor entirely

    // Control: the SAME floor override on an equivalent MULTI-term corpus
    // does filter the low-score hit — proving the override mechanism itself
    // works, and that single-term survival above is the gate, not a fluke.
    const multiTermTexts = [
      "alpha beta gamma delta ".repeat(3) + "design review",
      "alpha mentioned once in an unrelated paragraph",
    ];
    const e2: RenderedEntry[] = multiTermTexts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m2: Message[] = multiTermTexts.map((t) => ({ role: "user", content: t } as any));
    const r2 = search(m2, "alpha beta gamma delta", { relativeFloor: 0.9, cap: 1e9 });
    expect(r2.hits.map((h) => h.index)).toEqual([0]); // low-score hit filtered
  });

  it("gates on DISTINCT normalized terms — duplicate/case-duplicate words stay single-term", () => {
    // "auth auth" / "Auth AUTH" is semantically ONE term repeated/recased,
    // not a multi-term query. Same aggressive floor (0.9) and corpus shape
    // as above: the low-score hit must still survive every variant.
    const texts = [
      "auth ".repeat(20) + "flow rewritten",
      "one mention of auth here in an otherwise unrelated changelog entry",
    ];
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));

    for (const q of ["auth auth", "Auth AUTH", "auth Auth auth"]) {
      const r = search(m, q, { relativeFloor: 0.9, cap: 1e9 });
      expect(r.hits.map((h) => h.index).sort()).toEqual([0, 1]);
    }
  });
});

describe("search hard result cap", () => {
  const size = 60;
  const bm25Entries: RenderedEntry[] = Array.from({ length: size }, (_, i) => ({
    index: i, role: "user", summary: `zebra_query_tag entry number ${i}`,
  }));
  const bm25Messages: Message[] = bm25Entries.map((e) => ({ role: "user", content: e.summary } as any));

  it("bounds the BM25/natural-language path to SEARCH_RESULT_CAP (50)", () => {
    // Disable the floor so the cap's effect is isolated — all 60 entries
    // are equally strong single-term matches, so none would be floor-filtered.
    const r = search(bm25Messages, "zebra_query_tag", { relativeFloor: 0 });
    expect(r.totalBeforeCap).toBe(60);
    expect(r.hits).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("bounds the regex path to SEARCH_RESULT_CAP (50), with default tuning (no override)", () => {
    const regexEntries: RenderedEntry[] = Array.from({ length: size }, (_, i) => ({
      index: i, role: "user", summary: `zebra_query_tag entry number ${i}`,
    }));
    const regexMessages: Message[] = regexEntries.map((e) => ({ role: "user", content: e.summary } as any));
    // "." makes this a regex-mode query (looksLikeRegex), no BM25/floor involved.
    const r = search(regexMessages, "zebra_query_tag.*entry");
    expect(r.totalBeforeCap).toBe(60);
    expect(r.hits).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("does not truncate when raw hits are under the cap", () => {
    const small = bm25Entries.slice(0, 10);
    const smallMsgs = bm25Messages.slice(0, 10);
    const r = search(smallMsgs, "zebra_query_tag");
    expect(r.hits).toHaveLength(10);
    expect(r.totalBeforeCap).toBe(10);
    expect(r.truncated).toBe(false);
  });
});

describe("a hit's snippet", () => {
  it("shows where the term matched, also when only its stem did", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "x" }];
    const m: Message[] = [{ role: "assistant", content: [{ type: "text", text: `${"filler line\n".repeat(12)}the totals round down here\nlast line` }] } as any];
    // "rounding" matches "round" by its stem only.
    const [hit] = searchHits(m, "rounding");
    expect(hit.snippet).toContain("round down");
  });
});
