// The Lisp core's raw capture (lisp/src/raw-capture.lisp, ops raw-capture and
// placeholders) against src/hooks/raw-capture.ts: generated sessions captured
// event by event (entries arriving in chunks, a session switch and back, a
// fork whose parent's store already keeps some originals, malformed store
// lines, a host whose entry list shrinks), compared by what each event keeps,
// the store files byte for byte and what the binding knows is kept; and
// generated requests whose tool results omp blanked, compared by the pointers
// written on them. Skips without SBCL.
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureNewEntries, createRawCaptureState, pointPlaceholders } from "../src/hooks/raw-capture";
import { rawStorePath } from "../src/core/raw-store";
import { lispCore, withCore } from "./support/lisp-core";

const core = lispCore();
const maybe = core ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), "omp-vcc-lisp-raw-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const words = (r: () => number, n: number) => Array.from({ length: n }, () => pick(r, ["fix", "the", "bug", "café", "🎉", "src/a.ts", " ", "\u0001", "\"q\"", "\\"])).join(" ");

/** A message entry of some shape omp writes, or a malformed one. */
const entryOf = (r: () => number, i: number, ids: string[]): any => {
  const id = r() < 0.06 && ids.length ? pick(r, ids) : r() < 0.03 ? pick(r, [7, null, undefined]) : `m${i}`;
  if (typeof id === "string") ids.push(id);
  const long = () => words(r, 200 + Math.floor(r() * 200));
  const message = pick(r, [
    () => ({ role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: words(r, 1 + Math.floor(r() * 30)) }] }),
    () => ({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "QUJD" }, null, [1], { type: "text", text: 5 }] }),
    () => ({ role: "toolResult", toolCallId: `c${i}`, content: [] }),
    () => ({ role: "toolResult", toolCallId: `c${i}`, content: "a string result" }),
    () => ({ role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "[Output truncated - 900 tokens]" }], prunedAt: pick(r, [1, null]) }),
    () => ({ role: "assistant", content: [{ type: "text", text: long() }, { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "ls" } }] }),
    () => ({ role: "assistant", content: [{ type: "text", text: "short" }] }),
    () => ({ role: pick(r, ["user", "developer"]), content: long() }),
    () => ({ role: "user", content: "short ask" }),
    () => ({ role: "bashExecution", command: "ls", output: long() }),
    () => pick(r, [null, "x", 0, {}]),
  ])();
  return { type: r() < 0.95 ? "message" : "custom", ...(id === undefined ? {} : { id }), parentId: null, ...(message === undefined ? {} : { message }) };
};

const LONG_ID = `L${"o".repeat(600)}ng`;

/** One world's files: a parent session with a store, a child forked from it, another session. */
const world = (root: string, seed: number) => {
  mkdirSync(root, { recursive: true });
  const parent = join(root, "parent.jsonl");
  const child = join(root, "child.jsonl");
  const other = join(root, "other.jsonl");
  writeFileSync(parent, `${JSON.stringify({ type: "session", id: "p" })}\n`);
  writeFileSync(child, `${JSON.stringify({ type: "session", id: "c", parentSession: parent })}\n`);
  writeFileSync(other, `${JSON.stringify({ type: "session", id: "o" })}\n`);
  // The parent's store keeps some of the ids the child carries; a malformed line stops the scan of it.
  const store = [`{"id":"m1","content":"kept"}`, `{"id":"m3","content":[]}`, ...(seed % 3 === 0 ? [`{"id":"bad\\x"}`, `{"id":"m5","content":"after"}`] : []), "", `not json`, `{"id":"m\\u0037","content":1}`, `{"id":"${LONG_ID}","content":"x"}`];
  writeFileSync(rawStorePath(parent), store.join("\n") + (seed % 2 ? "\n" : ""));
  if (seed % 4 === 0) writeFileSync(rawStorePath(other), `{"id":"m2","content":"x"}\n`);
  return { parent, child, other };
};

const runCapture = (seed: number, useCore: string | undefined) => {
  const r = rng(seed * 7717);
  const files = world(join(dir, `w${seed}-${useCore ? "core" : "ts"}`), seed);
  const ids: string[] = [];
  const all = Array.from({ length: 10 + Math.floor(r() * 50) }, (_, i) => entryOf(r, i, ids));
  // At the edges: a text exactly omp's shakeable size and one under it, two parts
  // that pass the kept budget only together, one past it, an id past a store line's 512-byte head.
  if (seed === 1) all.push(
    { type: "message", id: "huge", message: { role: "toolResult", toolCallId: "h", content: [{ type: "text", text: "h".repeat(1_000_050) }, { type: "text", text: "after" }] } },
    { type: "message", id: "halves", message: { role: "toolResult", toolCallId: "h2", content: [{ type: "text", text: "a".repeat(600_000) }, { type: "text", text: "b".repeat(600_000) }] } },
    { type: "message", id: "edge", message: { role: "assistant", content: [{ type: "text", text: "e".repeat(1_200) }] } },
    { type: "message", id: "under", message: { role: "user", content: "u".repeat(1_199) } },
    { type: "message", id: LONG_ID, message: { role: "toolResult", toolCallId: "l", content: [{ type: "text", text: "long id" }] } },
  );
  const state = createRawCaptureState();
  let file = files.child;
  let shown = 0;
  const sm = { getSessionFile: () => file, getEntries: () => all.slice(0, shown) };
  const events: unknown[] = [];
  withCore(useCore, () => {
    while (shown < all.length) {
      shown = Math.min(all.length, shown + 1 + Math.floor(r() * 8));
      const roll = r();
      if (roll < 0.08) file = file === files.child ? files.other : files.child;
      else if (roll < 0.12) shown = Math.max(0, shown - 5);
      events.push({ file: file === files.child ? "child" : "other", shown, kept: captureNewEntries(state, sm) });
    }
  });
  const store = (f: string) => (existsSync(rawStorePath(f)) ? readFileSync(rawStorePath(f)).toString("base64") : null);
  return { events, stores: [store(files.child), store(files.other), store(files.parent)], kept: [...state.kept].sort(), seen: state.seen };
};

maybe("Lisp core raw capture", () => {
  it("keeps the originals of generated sessions, event by event, as captureNewEntries does", () => {
    let kept = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const ts = runCapture(seed, undefined);
      const lisp = runCapture(seed, core);
      expect({ seed, ...lisp }).toEqual({ seed, ...ts });
      kept += ts.kept.length;
    }
    expect(kept).toBeGreaterThan(500);
  }, 120_000);

  it("points omp's placeholders at the kept originals as pointPlaceholders does", () => {
    const PLACEHOLDERS = ["[Output truncated - 1200 tokens]", "[Superseded by a newer read of this file]", "[Uneventful result elided]", "[Output truncated - many tokens]", " [Uneventful result elided]", "[Output truncated - 5 tokens]\n"];
    let pointed = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 4241);
      const entries: any[] = [];
      const branch: any[] = [];
      for (let i = 0; i < 5 + Math.floor(r() * 30); i++) {
        const callId = `c${Math.floor(r() * 12)}`;
        const id = r() < 0.05 ? pick(r, [undefined, 5, "", `t${i - 1}`]) : `t${i}`;
        const e = r() < 0.7
          ? { type: "message", ...(id === undefined ? {} : { id }), message: { role: "toolResult", toolCallId: r() < 0.05 ? 3 : callId, content: [] } }
          : r() < 0.5 ? { type: "message", id: `u${i}`, message: { role: "user", content: "x" } } : { type: pick(r, ["custom", "message"]), id: `x${i}`, ...(r() < 0.5 ? { message: null } : {}) };
        entries.push(e);
        if (r() < 0.85) branch.push(e);
      }
      const messages = Array.from({ length: Math.floor(r() * 15) }, () => pick(r, [
        () => ({ role: "toolResult", toolCallId: `c${Math.floor(r() * 12)}`, content: [{ type: "text", text: pick(r, PLACEHOLDERS) }] }),
        () => ({ role: "toolResult", toolCallId: `c${Math.floor(r() * 12)}`, content: [{ type: "text", text: "real output" }] }),
        () => ({ role: "toolResult", toolCallId: `c${Math.floor(r() * 12)}`, content: [{ type: "text", text: PLACEHOLDERS[0] }, { type: "text", text: "x" }] }),
        () => ({ role: "toolResult", content: [{ type: "text", text: PLACEHOLDERS[1] }] }),
        () => ({ role: "assistant", content: [{ type: "text", text: PLACEHOLDERS[2] }] }),
        () => ({ role: "toolResult", toolCallId: "c1", content: PLACEHOLDERS[0] }),
      ])());
      const state = createRawCaptureState();
      for (const e of entries) if (typeof e.id === "string" && r() < 0.6) state.kept.add(e.id);
      if (r() < 0.1) state.kept.clear();
      const sm = { getBranch: () => branch, getEntries: () => entries };
      const ts = withCore(undefined, () => pointPlaceholders(messages, state, sm));
      const lisp = withCore(core, () => pointPlaceholders(messages, state, sm));
      expect({ seed, out: lisp }).toEqual({ seed, out: ts });
      if (ts) pointed++;
    }
    expect(pointed).toBeGreaterThan(40);
  });
});
