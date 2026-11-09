// What the agent recalled, read back as a signal (lisp/src/feedback.lisp), and
// turns that carry on one another leaving and coming back together
// (lisp/src/links.lisp): eviction holds what was recalled lately, brings back a
// turn re-read twice, never cuts a linked chain, and [Working Set] brings back
// what was recalled first.
import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { core } from "../src/core";
import { callCommand, callTool, requestContext } from "./support/binding";
import { EVICT_ENTRY_TYPE, RECALL_ENTRY_TYPE } from "./support/names";
import { freshDir, writeJsonl } from "./support/session-files";
import { tempConfig } from "./support/config";

const config = tempConfig("keel-feedback-", { evict: true });


/** What one turn does besides its request and reply: read a file, edit one, or run a command that fails or passes. */
type Act = { read: string } | { edit: string } | { bash: string; fail: boolean };

/** A session of turns, each a request, one call and its result of SIZE chars, and the reply that ends it (4 entries: #4i to #4i+3). */
const session = (acts: Act[], size = 200, prompt?: number) => {
  const messages: any[] = [];
  acts.forEach((act, i) => {
    messages.push({ role: "user", content: `request number ${i}` });
    const call = "read" in act ? { name: "read", arguments: { path: act.read } }
      : "edit" in act ? { name: "edit", arguments: { path: act.edit, oldText: `a${i}`, newText: `b${i}` } }
      : { name: "bash", arguments: { command: act.bash } };
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, ...call }] });
    messages.push({ role: "toolResult", toolCallId: `c${i}`, toolName: call.name, isError: "bash" in act && act.fail, content: [{ type: "text", text: `${i}:`.padEnd(size, "x") }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: `Done ${i}.` }] });
  });
  if (prompt !== undefined) messages.at(-3).usage = { input: prompt, output: 10, cacheRead: 0, cacheWrite: 0 };
  const entries: any[] = [];
  let t = 1_700_000_000_000;
  for (const message of messages) entries.push({ type: "message", id: `e${entries.length}`, parentId: entries.at(-1)?.id ?? null, message: { ...message, timestamp: t++ } });
  const file = join(freshDir(), "session.jsonl");
  writeJsonl(file, entries);
  const appended: any[] = [];
  const host = {
    appendEntry: (customType: string, data?: unknown) => {
      const e = { type: "custom", id: `x${entries.length}`, parentId: entries.at(-1)?.id ?? null, customType, data };
      entries.push(e);
      appended.push(e);
    },
  };
  const sessionManager = { getSessionFile: () => file, getBranch: () => entries, getEntries: () => entries };
  const ctx = (window?: number) => ({ sessionManager, model: window ? { provider: "p", id: "m", contextWindow: window } : null });
  const request = () => entries.filter((e) => e.type === "message").map((e) => structuredClone(e.message));
  return { entries, appended, host, ctx, request };
};
type Session = ReturnType<typeof session>;

const reads = (n: number): Act[] => Array.from({ length: n }, (_, i) => ({ read: `f${i}.ts` }));
/** The next request through keel's context event, with a 100K window: omp compacts at 83,616 tokens, keel evicts past 85% of that. */
const sent = (s: Session) => requestContext(s.request(), s.ctx(100_000), s.host);
/** A recall the agent made at #N count AT that showed NS. */
const recalled = (s: Session, ns: number[], at: number) => s.host.appendEntry(RECALL_ENTRY_TYPE, { v: 1, ns, at });
const ops = (s: Session, type = EVICT_ENTRY_TYPE) => s.appended.filter((e) => e.customType === type).map((e) => e.data);

describe("what keel_recall showed", () => {
  it("is recorded, with the #N count then, so keel can read what the agent needs", () => {
    const s = session(reads(4));
    callTool("keel_recall", { expand: [5] }, s.ctx(), s.host);
    // #5 is a call; expand shows its result #6 with it.
    expect(ops(s, RECALL_ENTRY_TYPE)).toEqual([{ v: 1, ns: [5, 6], at: 16 }]);
  });

  it("records the hits a search showed, and nothing when it showed nothing", () => {
    const s = session(reads(4));
    callTool("keel_recall", { query: "request number 2" }, s.ctx(), s.host);
    expect(ops(s, RECALL_ENTRY_TYPE)[0].ns).toContain(8);
    callTool("keel_recall", { query: "zebracorn" }, s.ctx(), s.host);
    expect(ops(s, RECALL_ENTRY_TYPE)).toHaveLength(1);
  });
});

describe("eviction, as the context fills", () => {
  it("takes a turn the agent recalled lately out after the others: the next ones go first", () => {
    const plain = session(reads(10), 30_000, 80_000);
    sent(plain);
    expect(ops(plain)[0]).toMatchObject({ op: "evict", from: 0, by: "auto" });

    const held = session(reads(10), 30_000, 80_000);
    // At #39, in the running turn: the agent looked at turn 0's request.
    recalled(held, [0], 39);
    sent(held);
    const out = ops(held).filter((o) => o.op === "evict");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((o) => o.from > 3)).toBe(true);
    expect(out[0].from).toBe(4);
  });

  it("a turn recalled lately still leaves before the running turn is cut into: it leaves last, it is not held outright", () => {
    const s = session(reads(10), 30_000, 80_000);
    // Every finished turn recalled just now.
    recalled(s, [0, 4, 8, 12, 16, 20, 24, 28, 32], 39);
    sent(s);
    const out = ops(s).filter((o) => o.op === "evict");
    expect(out[0]).toMatchObject({ from: 0, by: "auto" });
    // Nothing of the running turn (#36 on).
    expect(out.every((o) => o.to < 36)).toBe(true);
  });

  it("forgets a recall a few turns on: the turn can leave again", () => {
    const s = session(reads(10), 30_000, 80_000);
    // At #6, seven turns ago.
    recalled(s, [0], 6);
    sent(s);
    expect(ops(s)[0]).toMatchObject({ op: "evict", from: 0 });
  });

  /** What keel has learned of the test's model ("p/m"): how often it recalls a turn again; none, a model not seen yet. */
  const model = (rereadContinue?: number) => {
    const file = join(config.dir, "keel-models.json");
    if (rereadContinue === undefined) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify({ "p/m": { rereadContinue } }));
  };

  it("brings back a turn the agent recalled since it left when this model keeps going back, and says so", () => {
    model(0.95);
    const s = session(reads(10), 200, 2_000);
    s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, op: "evict", from: 0, to: 3, by: "auto", at: 8 });
    recalled(s, [1], 37);
    const { notice } = sent(s);
    expect(ops(s).filter((o) => o.op === "restore")).toEqual([expect.objectContaining({ op: "restore", from: 0, to: 3, by: "auto" })]);
    expect(notice).toBe("keel: #0–#3 back in context · the agent keeps recalling it, and keeping it costs less than recalling it again.");
    model();
  });

  it("leaves it out for a model keel has not seen go back, where the same recalls do not pay for it", () => {
    model();
    const s = session(reads(10), 200, 2_000);
    s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, op: "evict", from: 0, to: 3, by: "auto", at: 8 });
    recalled(s, [1], 37);
    recalled(s, [2], 39);
    expect(sent(s).notice).toBeUndefined();
    expect(ops(s).filter((o) => o.op === "restore")).toEqual([]);
  });

  it("counts only the recalls since a turn last left: brought back and taken out again, it starts over", () => {
    model(0.95);
    const s = session(reads(10), 200, 2_000);
    s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, op: "evict", from: 0, to: 3, by: "auto", at: 8 });
    recalled(s, [1], 30);
    sent(s);
    expect(ops(s).filter((o) => o.op === "restore")).toHaveLength(1);
    // Taken out again after that recall: it does not come back on it again.
    s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, op: "evict", from: 0, to: 3, by: "auto", at: 34 });
    sent(s);
    sent(s);
    expect(ops(s).filter((o) => o.op === "restore")).toHaveLength(1);
    // A recall since it left again does.
    recalled(s, [1], 36);
    sent(s);
    expect(ops(s).filter((o) => o.op === "restore")).toHaveLength(2);
    model();
  });

  it("learns how often the model recalls a turn again from the session, and keeps it for the model", () => {
    model();
    const s = session(reads(10), 200, 2_000);
    for (const [from, to] of [[0, 3], [4, 7]]) s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, op: "evict", from, to, by: "auto", at: 16 });
    // Each out turn recalled twice in a row (a continuation), then left alone for more than three turns (a stop):
    // half of its recalls went on, more than the prior's 0.3 says.
    recalled(s, [1], 17);
    recalled(s, [1], 18);
    recalled(s, [5], 17);
    recalled(s, [5], 18);
    sent(s);
    const q = JSON.parse(readFileSync(join(config.dir, "keel-models.json"), "utf8"))["p/m"].rereadContinue;
    expect(q).toBeGreaterThan(0.3);
    expect(q).toBeLessThan(0.5);
    model();
  });

  it("never cuts a chain of linked turns: the turn that carries on the last one leaving leaves with it", () => {
    // Where the cut falls with nothing linked.
    const plain = session(reads(10), 30_000, 80_000);
    sent(plain);
    const to = ops(plain)[0].to as number;
    const last = (to - 3) / 4;
    // The last turn leaving and the one after it edit the same file.
    const acts = reads(10);
    acts[last] = { edit: "src/shared.ts" };
    acts[last + 1] = { edit: "src/shared.ts" };
    const linked = session(acts, 30_000, 80_000);
    sent(linked);
    expect(ops(linked)[0]).toMatchObject({ op: "evict", from: 0, to: to + 4 });
  });
});

describe("the evict command and keel_context", () => {
  const user = (s: Session, args: string) => callCommand("evict", args, s.ctx(), s.host);

  it("the oldest half keeps a failure and its fix together", () => {
    // Four finished turns: the oldest half is turns 0 and 1.
    expect((() => { const s = session(reads(5)); user(s, ""); return ops(s); })()).toEqual([expect.objectContaining({ from: 0, to: 7 })]);
    const s = session([{ read: "a.ts" }, { bash: "bun test", fail: true }, { bash: "bun test", fail: false }, { read: "b.ts" }, { read: "c.ts" }]);
    user(s, "");
    expect(ops(s)).toEqual([expect.objectContaining({ from: 0, to: 11 })]);
  });

  it("bringing a turn back brings back the turns linked to it, not the others", () => {
    const s = session([{ read: "a.ts" }, { edit: "src/x.ts" }, { edit: "src/x.ts" }, { read: "b.ts" }, { read: "c.ts" }]);
    for (const range of ["#0-#3", "#4-#7", "#8-#11"]) user(s, range);
    expect(user(s, "restore #4")).toBe("Back in context from the next request: #4–#7, #8–#11.");
    // The agent's restore does the same.
    const t = session([{ read: "a.ts" }, { edit: "src/x.ts" }, { edit: "src/x.ts" }, { read: "b.ts" }, { read: "c.ts" }]);
    for (const range of ["#0-#3", "#4-#7", "#8-#11"]) user(t, range);
    expect(callTool("keel_context", { restore: ["#8"] }, t.ctx(), t.host)).toStartWith("Back in context from the next request: #4–#7, #8–#11.");
  });

  it("an explicit range is taken as given, linked or not", () => {
    const s = session([{ read: "a.ts" }, { edit: "src/x.ts" }, { edit: "src/x.ts" }, { read: "b.ts" }, { read: "c.ts" }]);
    user(s, "#4-#7");
    expect(ops(s)).toEqual([expect.objectContaining({ from: 4, to: 7 })]);
  });

  it("the listing marks a turn the agent recalled lately, which keel leaves in", () => {
    const s = session(reads(5));
    recalled(s, [5], 19);
    const list = callTool("keel_context", null, s.ctx(), s.host);
    expect(list).toContain("#4–#7 ~");
    expect(list.split("\n").find((l) => l.includes("#4–#7"))).toEndWith("(you recalled it lately: it leaves last)");
    expect(list.split("\n").find((l) => l.includes("#0–#3"))).not.toContain("recalled");
  });
});

describe("[Working Set]", () => {
  const text = (t: string) => [{ type: "text", text: t }];
  const history = [
    { role: "user", content: "set up the deploy" },
    { role: "assistant", content: [{ type: "toolCall", id: "k1", name: "bash", arguments: { command: "cat deploy.log" } }] },
    { role: "toolResult", toolCallId: "k1", toolName: "bash", content: text(`deploy log\n${"step ok\n".repeat(80)}`), isError: false },
    { role: "assistant", content: text("Deployed.") },
    { role: "user", content: "now write the changelog" },
  ];
  const pick = (recalled?: number[]) =>
    core({ op: "working-set", history, indices: [0, 1, 2, 3, 4], kept: [], maxChars: 4_000, ...(recalled ? { recalled } : {}) }).items as Array<{ index: number; note: string }>;

  it("brings back what the agent recalled lately, by its result", () => {
    expect(pick().some((i) => i.index === 2)).toBe(false);
    expect(pick([1])).toEqual([expect.objectContaining({ index: 2, note: "recalled lately" })]);
    expect(pick([2])).toEqual([expect.objectContaining({ index: 2, note: "recalled lately" })]);
  });
});

describe("credit per eviction, by kind of turn (lisp/src/credit.lisp)", () => {
  let models = "";
  beforeAll(() => { models = join(config.dir, "keel-models.json"); });
  const failing = (n: number): Act[] => Array.from({ length: n }, (_, i) => ({ bash: `bun test t${i}`, fail: true }));
  const covers = (s: Session, n: number) => ops(s).some((op: any) => op.op === "evict" && op.from <= n && n <= op.to);

  it("with no evidence, the oldest finished turns leave first, whatever their kind", () => {
    rmSync(models, { force: true });
    const s = session([...failing(1), ...reads(9)], 30_000, 80_000);
    sent(s);
    expect(ops(s)[0]).toMatchObject({ op: "evict", from: 0, by: "auto" });
  });

  it("a kind this model keeps recalling once out leaves after the others", () => {
    writeFileSync(models, JSON.stringify({ "p/m": { recallAfterEvict: { failed: 0.8, changed: 0.1, read: 0.05 } } }));
    const s = session([...failing(1), ...reads(9)], 30_000, 80_000);
    sent(s);
    expect(ops(s)[0]).toMatchObject({ op: "evict", from: 4, by: "auto" });
    expect(covers(s, 0)).toBe(false);
    rmSync(models, { force: true });
  });

  it("learns each kind's rate from the session: failed turns recalled once out, reads never", () => {
    rmSync(models, { force: true });
    const s = session([...failing(5), ...reads(11)], 30_000, 80_000);
    // Turns 0–9 went out at #40; the agent then recalled each failed one, and none of the reads.
    s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, op: "evict", from: 0, to: 39, by: "auto", at: 40 });
    for (let i = 0; i < 5; i++) recalled(s, [4 * i + 2], 41 + i);
    sent(s);
    const learned = JSON.parse(readFileSync(models, "utf8"))["p/m"].recallAfterEvict;
    // Kept for the kinds the session showed enough of: failed turns above the prior, reads below it.
    expect(Object.keys(learned).sort()).toEqual(["failed", "read"]);
    expect(learned.failed).toBeGreaterThan(0.2);
    expect(learned.read).toBeLessThan(0.2);
    rmSync(models, { force: true });
  });
});
