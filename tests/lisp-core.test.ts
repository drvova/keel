// The Lisp core's search against search-entries.ts: the same corpus and query
// through both, every hit, snippet and count compared. Skips without SBCL.
import { describe, expect, it } from "bun:test";
import { searchEntries } from "../src/core/search-entries";
import { callCore } from "../src/core/lisp-core";
import type { LoadedEntry } from "../src/core/load-messages";
import { assistantText, userMsg } from "./fixtures";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;

// A fixed generator, so a failure names a seed that reproduces it.
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const VOCAB = [
  "the", "a", "is", "of", "rounding", "rounds", "round", "Rounded", "ROUNDING", "stopping", "stop", "stopped",
  "failure", "fail", "FAIL", "failed", "test", "tests", "testing", "money", "parse", "parser", "parsing",
  "auth", "Auth", "login", "café", "naïve", "Привет", "мир", "日本語", "中文", "🎉", "👨‍👩‍👧", "x", "ab",
  "file_name.test.ts", "src/money", "v2", "error", "errors", "TypeError", "commit", "commits", "deploy",
  "surrounds", "background", "grounding", "it's", "don't", "rm", "-rf", "foo_bar", "fooBar",
];
const BASE64 = "QmFzZTY0IGVuY29kZWQgZGF0YSBzaG91bGQgYmUgZHJvcHBlZA0K".repeat(25);

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const corpus = (seed: number, size: number): LoadedEntry[] => {
  const r = rng(seed);
  return Array.from({ length: size }, (_, index) => {
    const lines = Array.from({ length: 1 + Math.floor(r() * 8) }, () => {
      const words = Array.from({ length: 1 + Math.floor(r() * (r() < 0.1 ? 120 : 14)) }, () => pick(r, VOCAB));
      if (r() < 0.05) words.push(BASE64);
      return words.join(r() < 0.1 ? "　" : " ");
    });
    const text = lines.join("\n");
    const user = r() < 0.4;
    const files = r() < 0.3 ? [pick(r, ["src/money.ts", "src/auth/login.ts", "README.md"])] : undefined;
    return {
      entry: { index, role: user ? "user" : "assistant", summary: text.slice(0, 80), ...(files ? { files } : {}) },
      message: user ? userMsg(text) : assistantText(text),
    };
  });
};

// Mostly words; now and then a regex query, or a term with a metacharacter, which runs
// the regex path and, when it finds nothing, the term search with regex terms.
const REGEXES = ["round.*fail", "money\\.ts", "^user", "test(s|ing)?$", "(fail|error)ed", "[A-Z]\\w+Error", "café|naïve", "🎉", ".", "(a+)+", "a(", "\\bstop", "x{2,}", "src/money?"];
const query = (r: () => number): string =>
  Array.from({ length: 1 + Math.floor(r() * 3) }, () => (r() < 0.15 ? pick(r, REGEXES) : pick(r, VOCAB))).join(" ");

const both = (items: LoadedEntry[], q: string, cap?: number) => ({
  ts: withCore(undefined, () => searchEntries(items, q, cap ? { cap } : undefined)),
  lisp: withCore(core, () => searchEntries(items, q, cap ? { cap } : undefined)),
});

maybe("Lisp core search", () => {
  it("answers through the core, not the TS fallback", () => {
    const reply = withCore(core, () => callCore({ op: "search", query: "rounding", docs: [{ role: "user", text: "rounds", files: [] }] }));
    expect(reply?.hits).toEqual([{ index: 0, snippet: "rounds" }]);
  });

  it("matches search-entries.ts hit for hit on generated sessions", () => {
    let compared = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const items = corpus(seed, 20 + seed * 5);
      const r = rng(seed * 7919);
      for (let k = 0; k < 15; k++) {
        const q = query(r);
        const { ts, lisp } = both(items, q, k % 5 === 0 ? 5 : undefined);
        expect({ seed, q, ...lisp }).toEqual({ seed, q, ...ts });
        compared++;
      }
    }
    expect(compared).toBe(600);
  }, 120_000);

  it("matches on lines long enough to clip, around emoji", () => {
    const line = `${"🎉".repeat(200)} needle ${"x".repeat(400)}`;
    const items: LoadedEntry[] = [{ entry: { index: 0, role: "user", summary: "" }, message: userMsg(`a\n${line}\nb`) }];
    const { ts, lisp } = both(items, "needle");
    expect(lisp).toEqual(ts);
    expect(lisp.hits[0].snippet).toContain("needle");
  });

  it("runs regex queries, and leaves refused constructs to the TS code", () => {
    expect(withCore(core, () => callCore({ op: "search", query: "money.ts", docs: [{ role: "user", text: "money.ts", files: [] }] }))?.hits).toHaveLength(1);
    expect(withCore(core, () => callCore({ op: "search", query: "(?<n>a)", docs: [] }))).toBeUndefined();
    const items = corpus(3, 30);
    for (const q of ["round.*fail", "(?<n>round)", "zz.z rounding", "(a+)+ round"]) {
      const { ts, lisp } = both(items, q);
      expect({ q, ...lisp }).toEqual({ q, ...ts });
    }
  });
});
