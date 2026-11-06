// The Lisp core's regular expressions against JavaScript's own: generated and
// hand-picked patterns compiled as `new RegExp(p, "i")`, each run on generated
// texts; whether it compiles, test, search and the global match count are
// compared. A pattern the core leaves to TypeScript ("unsupported") is
// counted, and must stay rare. Skips without SBCL.
import { describe, expect, it } from "bun:test";
import { callCore } from "../src/core/lisp-core";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const ATOMS = [
  "a", "b", "A", "B", "x", "ß", "ſ", "s", "S", "K", "k", "K", "é", "É", "ǅ", "ı", "i", "İ", "Σ", "ς", "σ", "1", "_", "-", " ", "🎉", ".", ".",
  "\\d", "\\w", "\\s", "\\D", "\\W", "\\S", "\\b", "\\B", "\\t", "\\n", "\\x41", "\\x4", "\\u0041", "\\u004", "\\u{41}", "\\cA", "\\cj", "\\c1", "\\c",
  "\\0", "\\1", "\\2", "\\k", "\\q", "\\.", "\\-", "\\/", "\\]", "\\", "\\ud83c",
  "[abc]", "[a-z]", "[^a-z]", "[\\d-x]", "[z-a]", "[a-]", "[]", "[^]", "[\\b]", "[\\c1]", "[-a]", "[A-z]", "[\\w\\s]", "[^\\S]", "[.]", "[ſ]", "[\\u017F]", "[k-k]", "[\\0]", "[\\-]", "[a",
  "^", "$", "|", "(", ")", "{", "}", "]", "{2}", "{a}", "{1,", "{,2}",
];
const QUANTS = ["", "", "", "*", "+", "?", "*?", "+?", "??", "{2}", "{1,3}", "{2,}", "{3,1}", "{0}", "{1,3}?", "**", "+*"];

const pattern = (r: () => number): string => {
  const piece = (depth: number): string => {
    const roll = r();
    if (depth < 2 && roll < 0.12) return `(${piece(depth + 1)}${piece(depth + 1)})`;
    if (depth < 2 && roll < 0.17) return `(?:${piece(depth + 1)}|${piece(depth + 1)})`;
    if (depth < 2 && roll < 0.21) return `(?${pick(r, ["=", "!", "<=", "<!"])}${piece(depth + 1)})`;
    return pick(r, ATOMS) + pick(r, QUANTS);
  };
  return Array.from({ length: 1 + Math.floor(r() * 4) }, () => piece(0)).join(r() < 0.15 ? "|" : "");
};

const ALPHABET = ["a", "b", "A", "B", "x", "X", "ß", "SS", "ſ", "s", "S", "K", "k", "K", "é", "É", "ǅ", "Ǆ", "ǆ", "ı", "i", "I", "İ", "Σ", "ς", "σ", "1", "2", "_", "-", " ", "\t", "\n", "\r", " ", " ", "🎉", "\ud83c", "\u0001", "\u000a", "[", "]", ".", "\\", "c", "/", "u", "0", "4", "{", "}", ","];
const text = (r: () => number): string => Array.from({ length: Math.floor(r() * 14) }, () => pick(r, ALPHABET)).join("");

const HAND_PICKED = [
  "(a)\\1", "(a)|\\1b", "(a*)*b", "(a|ab)(c|bcd)(d*)", "(?=(a))\\1", "(?!(a))\\1", "(a)?\\1", "((a)|b)+", "(z)((a+)?(b+)?(c))*",
  "\\u{2}", "a{,5}", "x{2}{3}", "(?<=ab)c", "(?<!a)b", "(?<=\\d{2})x", "(?<=a|bc)d", "(?<=(a))b", "(?<n>a)", "\\k<n>", "\\8", "[\\8]",
  "^*", "$+", "\\b*", "(?=a)*", "(?=a){2}", "(?<=a)?", "a**", "(?", "(?x)", "a)", "[", "\\", "[\\", "a{2,1}", "[b-a]", "[\\w-a]",
  "ſ", "[a-z]+", "K", "\\w+", "[^\\W]", "ς", "ǅ", ".+", "^$", "", "|", "a|", "()", "(|a)*", "(a?)*?b", "(?:)+", "\\B", "\\bk",
  "\\x", "\\xg1", "\\u12", "\\c", "\\c*", "[\\c]", "[\\c_]", "\\0", "\\00", "[\\0]",
];

// Pairs whose texts are chosen to reach what random texts rarely do: captures reset on each
// repetition, back-references after a repeat, lazy and greedy match lengths in a global count.
const TARGETED: [string, string[]][] = [
  ["((a)|b)+\\2", ["abb", "aba", "ab", "bab", "aab"]],
  ["(?:(a)|b)*\\1x", ["abx", "abax", "bx", "aax", "x"]],
  ["(a)?b\\1", ["bb", "ab", "aba", "b"]],
  ["(?:(a)|(b))+\\1\\2", ["abab", "ab", "ba", "aab"]],
  ["a*?", ["aaa", ""]],
  ["a+?", ["aaa"]],
  ["(a|ab)*c", ["abac", "ababc"]],
  ["\\u004", ["u004", "U004", "\u0041"]],
  ["\\x4g", ["x4g", "X4G"]],
  ["(?=(a+))a*b\\1", ["baaabac", "aab"]],
  ["(?:(?=(a))ab|ac)\\1", ["ac", "aca", "abx", "aba"]],
  ["(.)\\1", ["aA", "ſs", "kK", "\u212Ak"]],
];

const jsSide = (p: string, texts: string[]) => {
  let re: RegExp;
  try { re = new RegExp(p, "i"); } catch { return { status: "syntax" }; }
  const global = new RegExp(p, "gi");
  return {
    status: "ok",
    results: texts.map((t) => ({ test: re.test(t), search: t.search(re), count: (t.match(global) ?? []).length })),
  };
};

maybe("Lisp core regex", () => {
  it("compiles and matches as JavaScript does", () => {
    let compared = 0;
    let unsupported = 0;
    const r = rng(7);
    const patterns = [...HAND_PICKED, ...Array.from({ length: 1500 }, () => pattern(r))];
    for (const [i, p] of patterns.entries()) {
      const texts = Array.from({ length: 12 }, () => text(r));
      const lisp = withCore(core, () => callCore({ op: "regex", pattern: p, texts })) as any;
      expect(lisp).toBeDefined();
      if (lisp.status === "unsupported") { unsupported++; continue; }
      const { ok: _ok, ...got } = lisp;
      expect({ i, p, ...got }).toEqual({ i, p, ...jsSide(p, texts) });
      compared++;
    }
    for (const [p, texts] of TARGETED) {
      const lisp = withCore(core, () => callCore({ op: "regex", pattern: p, texts })) as any;
      expect(lisp.status).toBe("ok");
      const { ok: _ok, ...got } = lisp;
      expect({ p, ...got }).toEqual({ p, ...jsSide(p, texts) });
    }
    expect(compared).toBeGreaterThan(1200);
    expect(unsupported / patterns.length).toBeLessThan(0.2);
  }, 120_000);
});
