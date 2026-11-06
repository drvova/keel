// The Lisp core's projection of Pi's context edits (lisp/src/context-edits.lisp,
// op context-edits) against src/core/context-edits.ts over generated branches:
// omissions, replacements of every content shape (and malformed ones), edits of
// roles Pi does not edit, of entries that are not messages, of ids that are
// not there, and a target edited again. Op compact applies the same projection
// (tests/lisp-compaction.test.ts plans branches with edits). Skips without SBCL.
import { describe, expect, it } from "bun:test";
import { applyContextEdits } from "../src/core/context-edits";
import { callCore } from "../src/core/lisp-core";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const REPLACEMENTS: unknown[] = [
  null, undefined, 5, "a string", [], {}, { content: "[redacted]" }, { content: [{ type: "text", text: "edited" }] },
  { content: null }, { content: 0 }, { content: [{ type: "toolCall", id: "z", name: "bash", arguments: { command: "ls" } }] },
  { content: "café 🎉", extra: true }, { other: "no content" },
];

const branch = (seed: number): any[] => {
  const r = rng(seed);
  const entries: any[] = [];
  const size = 3 + Math.floor(r() * 25);
  for (let i = 0; i < size; i++) {
    const id = r() < 0.05 ? undefined : `e${i}`;
    const role = pick(r, ["user", "assistant", "toolResult", "custom", "bashExecution", "branchSummary", "compactionSummary"]);
    const roll = r();
    if (roll < 0.6) {
      entries.push({ type: "message", ...(id ? { id } : {}), parentId: null, message: r() < 0.05 ? pick(r, [null, "x", 0]) : {
        role, content: pick(r, ["text", [{ type: "text", text: "a" }], undefined]), ...(role === "toolResult" ? { toolCallId: "k", toolName: "bash" } : {}),
        ...(role === "bashExecution" ? { command: "ls", output: "a b" } : {}), timestamp: i,
      } });
    } else if (roll < 0.75) entries.push({ type: "custom_message", ...(id ? { id } : {}), customType: "note", content: "draft", display: true });
    else if (roll < 0.82) entries.push({ type: "branch_summary", ...(id ? { id } : {}), summary: "s", fromId: "x" });
    else if (roll < 0.86) entries.push({ type: "compaction", ...(id ? { id } : {}), summary: "c", firstKeptEntryId: "e0" });
    else entries.push({ type: "model_change", ...(id ? { id } : {}), model: "m" });
  }
  // Edits, after what they target or before it, a few aimed nowhere or malformed.
  for (let k = Math.floor(r() * 8); k > 0; k--) {
    const at = Math.floor(r() * (entries.length + 1));
    const targetId = r() < 0.1 ? pick(r, [undefined, 3, null, "missing"]) : `e${Math.floor(r() * size)}`;
    const replacement = pick(r, REPLACEMENTS);
    entries.splice(at, 0, { type: "context_edit", id: `x${k}`, ...(targetId === undefined ? {} : { targetId }), ...(replacement === undefined ? {} : { replacement }) });
  }
  return entries;
};

maybe("Lisp core context edits", () => {
  it("projects generated branches as applyContextEdits does", () => {
    let edited = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const b = branch(seed);
      const lisp = withCore(core, () => callCore({ op: "context-edits", branch: b }))?.entries;
      const ts = JSON.parse(JSON.stringify(applyContextEdits(b)));
      expect({ seed, entries: lisp }).toEqual({ seed, entries: ts });
      if (ts.length !== b.length) edited++;
    }
    expect(edited).toBeGreaterThan(200);
  });
});
