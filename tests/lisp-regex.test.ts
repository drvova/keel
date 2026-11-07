// The Lisp core's regular expressions against JavaScript's own: generated and
// hand-picked patterns compiled as `new RegExp(p, "i")`, each run on generated
// texts; whether it compiles, test, search and the global match count are
// compared. The core supports the whole non-unicode dialect but a
// back-reference into or inside a look-behind (matched backwards in
// JavaScript), which it refuses; those must stay rare.
import { describe, expect, it } from "bun:test";
import { core as callCore } from "../src/core/lisp-core";


const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const ATOMS = [
  "a", "b", "A", "B", "x", "ß", "ſ", "s", "S", "K", "k", "K", "é", "É", "ǅ", "ı", "i", "İ", "Σ", "ς", "σ", "1", "_", "-", " ", "🎉", ".", ".",
  "\\d", "\\w", "\\s", "\\D", "\\W", "\\S", "\\b", "\\B", "\\t", "\\n", "\\x41", "\\x4", "\\u0041", "\\u004", "\\u{41}", "\\cA", "\\cj", "\\c1", "\\c",
  "\\0", "\\1", "\\2", "\\k", "\\q", "\\01", "\\07", "\\12", "\\37", "\\377", "\\400", "\\8", "\\9", "\\18", "[\\12]", "[\\8]", "[\\01]",
  "(?<n>a)", "(?<x1>b)", "\\k<n>", "\\k<x1>", "\\k", "\\.", "\\-", "\\/", "\\]", "\\", "\\ud83c",
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

const ALPHABET = ["a", "b", "A", "B", "x", "X", "ß", "SS", "ſ", "s", "S", "K", "k", "K", "é", "É", "ǅ", "Ǆ", "ǆ", "ı", "i", "I", "İ", "Σ", "ς", "σ", "1", "2", "_", "-", " ", "\t", "\n", "\r", " ", " ", "🎉", "\ud83c", "\u0001", "\u000a", "[", "]", ".", "\\", "c", "/", "u", "0", "4", "8", "9", "A", "\u0001", "\u0008", "{", "}", ","];
const text = (r: () => number): string => Array.from({ length: Math.floor(r() * 14) }, () => pick(r, ALPHABET)).join("");

const HAND_PICKED = [
  "(a)\\1", "(a)|\\1b", "(a*)*b", "(a|ab)(c|bcd)(d*)", "(?=(a))\\1", "(?!(a))\\1", "(a)?\\1", "((a)|b)+", "(z)((a+)?(b+)?(c))*",
  "\\u{2}", "a{,5}", "x{2}{3}", "(?<=ab)c", "(?<!a)b", "(?<=\\d{2})x", "(?<=a|bc)d", "(?<=(a))b", "(?<n>a)", "\\k<n>", "\\8", "[\\8]",
  "^*", "$+", "\\b*", "(?=a)*", "(?=a){2}", "(?<=a)?", "a**", "(?", "(?x)", "a)", "[", "\\", "[\\", "a{2,1}", "[b-a]", "[\\w-a]",
  "ſ", "[a-z]+", "K", "\\w+", "[^\\W]", "ς", "ǅ", ".+", "^$", "", "|", "a|", "()", "(|a)*", "(a?)*?b", "(?:)+", "\\B", "\\bk",
  "\\x", "\\xg1", "\\u12", "\\c", "\\c*", "[\\c]", "[\\c_]", "\\0", "\\00", "[\\0]",
  // Named groups and their references; Annex B's octal escapes; a look-behind that captures.
  "(?<a>x)\\k<a>", "\\k<a>(?<a>x)", "(?<a>x)\\k<b>", "(?<a>x)\\k", "(?<a>x)[\\k]", "\\k<a>", "[\\k]", "(?<a>x)(?<a>y)", "(?<1a>x)", "(?<>x)", "(?<a",
  "(?<$_a1>x)\\1", "(?<é>x)\\k<é>", "(?<\\u0061>x)\\k<a>", "(?<\\u{62}>x)\\k<b>", "(?<\\u0031>x)", "(?<a\\u200d>x)", "(?<𝒜>x)\\k<𝒜>", "(?<a>x)|(?<b>y)\\k<a>", "(?<·a>x)",
  "\\01", "\\012", "\\0123", "\\08", "\\1", "\\12", "\\377", "\\400", "\\777", "\\8", "\\9", "\\81", "(a)\\12", "(a)\\2", "[\\1]", "[\\18]", "[\\9]", "[\\0-\\7]", "[\\101]",
  "(?<=(a))b", "(?<=(a)(b))c", "(?<!(a))b", "(?<=(?<n>a))b", "(a)(?<=\\1)b",
];

/** Back-references into or inside a look-behind, which JavaScript matches backwards: the only patterns left unsupported. */
const BACKWARDS = ["(?<=(a)\\1)b", "(?<=(a))\\1b", "(?<=\\1(a))b", "(?<=(?<n>a))\\k<n>"];

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

describe("Lisp core regex", () => {
  it("compiles and matches as JavaScript does", () => {
    let compared = 0;
    let unsupported = 0;
    const r = rng(7);
    const patterns = [...HAND_PICKED, ...Array.from({ length: 1500 }, () => pattern(r))];
    for (const [i, p] of patterns.entries()) {
      const texts = Array.from({ length: 12 }, () => text(r));
      const lisp = callCore({ op: "regex", pattern: p, texts }) as any;
      if (lisp.status === "unsupported") { unsupported++; continue; }
      const { ok: _ok, ...got } = lisp;
      expect({ i, p, ...got }).toEqual({ i, p, ...jsSide(p, texts) });
      compared++;
    }
    for (const [p, texts] of TARGETED) {
      const lisp = callCore({ op: "regex", pattern: p, texts }) as any;
      expect(lisp.status).toBe("ok");
      const { ok: _ok, ...got } = lisp;
      expect({ p, ...got }).toEqual({ p, ...jsSide(p, texts) });
    }
    expect(compared).toBeGreaterThan(1200);
    expect(unsupported / patterns.length).toBeLessThan(0.01);
    // Group names by the spec's ID_Start and ID_Continue, as V8 (Node, where Pi runs) reads them;
    // JavaScriptCore (Bun, where these tests run) refuses letter numbers and the Other_ID_* code points.
    for (const [p, ok] of [["(?<Ⅻ>x)\\k<Ⅻ>", true], ["(?<aⅫ>x)", true], ["(?<a·>x)", true], ["(?<℘>x)", true], ["(?<·a>x)", false], ["(?<a-b>x)", false]] as const) {
      expect({ p, status: (callCore({ op: "regex", pattern: p, texts: ["x"] }) as any).status }).toEqual({ p, status: ok ? "ok" : "syntax" });
    }
    for (const p of BACKWARDS) expect({ p, status: (callCore({ op: "regex", pattern: p, texts: ["ab"] }) as any).status }).toEqual({ p, status: "unsupported" });
  }, 120_000);
});
