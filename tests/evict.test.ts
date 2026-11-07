// Old turns out of the context whole (lisp/src/evict.lisp): taken out by the
// agent (vcc_context), the user (/omp-vcc-evict) or omp-vcc past 85% of the
// trigger, left out of every later request with one line in their place, and
// brought back; the session file keeps them, and vcc_recall reads them back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { evict, evictRequest, type EvictCall } from "../src/core/evict";
import { registerEviction } from "../src/hooks/eviction";
import { EVICT_ENTRY_TYPE, PIN_ENTRY_TYPE } from "../src/names";
import { executePin, ompBinding } from "./support/binding";
import { writeJsonl, freshDir } from "./support/session-files";

let dir: string;
const prev = process.env.OMP_VCC_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-evict-"));
  process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
});
afterAll(() => {
  if (prev === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});
const setEvict = (on: boolean) => writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ evict: on }));

/** A session of TURNS turns, each a request, a read and its result of SIZE chars, and the reply that ends it; the last read reports PROMPT tokens. */
const session = (turns: number, size = 200, prompt?: number) => {
  const messages: any[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `request number ${i} please read f${i}.ts` });
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i}.ts` } }] });
    messages.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: `${i}:`.padEnd(size, "x") }] });
    // A run ends with the assistant's reply.
    messages.push({ role: "assistant", content: [{ type: "text", text: `Read f${i}.ts.` }] });
  }
  if (prompt !== undefined) messages.at(-3).usage = { input: prompt, output: 10, cacheRead: 0, cacheWrite: 0 };
  return sessionOf(messages);
};

/** A session of these MESSAGES, one entry each on one branch, with its file, ledger and a request to send. */
const sessionOf = (messages: any[]) => {
  const entries: any[] = [];
  let t = 1_700_000_000_000;
  for (const message of messages) {
    const id = `e${entries.length}`;
    entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, message: { ...message, timestamp: t++ } });
  }
  const file = join(freshDir(), "session.jsonl");
  writeJsonl(file, entries);
  const appended: any[] = [];
  const host = {
    appendEntry: (customType: string, data?: unknown) => {
      const e = { type: "custom", id: `x${appended.length}`, parentId: entries.at(-1)?.id ?? null, customType, data };
      entries.push(e);
      appended.push(e);
    },
  };
  const sessionManager = { getSessionFile: () => file, getBranch: () => entries, getEntries: () => entries };
  const ctx = (window?: number) => ({ sessionManager, model: window ? { provider: "p", id: "m", contextWindow: window } : null });
  /** The request the host would send now: every message on the branch. */
  const request = () => entries.filter((e) => e.type === "message").map((e) => structuredClone(e.message));
  return { entries, appended, host, ctx, request, file };
};

const call = (s: ReturnType<typeof session>, c: EvictCall) => evict(s.host, ompBinding, s.ctx() as any, c);
const tool = (s: ReturnType<typeof session>, params: unknown) => call(s, { surface: "tool", params });
const sent = (s: ReturnType<typeof session>, window?: number, tool = false) => evictRequest(s.host, ompBinding, s.ctx(window) as any, s.request(), tool);
const record = (s: ReturnType<typeof session>, op: Record<string, unknown>) => s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, by: "agent", at: 99, ...op });
/** The line the request starts with while vcc_context is there: where the context's file is. */
const header = (s: { file: string }) => `[Your context is mirrored in ${s.file}.vcc-context.md, block by block as this request sends it. Edit that file to change what you hold: delete a [[CTX_TURN]] block to take its turn out, replace its text with what to keep of it, or write notes of your own between blocks. The next request sends what the file says. The session keeps every word (vcc_recall expand:[N] reads any original back); the running turn stays as it is.]`;
const texts = (messages: unknown[] | undefined) => (messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : m.content?.[0]?.text ?? m.content?.[0]?.type ?? ""));

describe("vcc_context", () => {
  it("lists the turns in context by #N, the running one last", () => {
    setEvict(true);
    const s = session(3);
    const text = tool(s, null);
    expect(text).toContain("In context: 3 turns");
    expect(text).toContain('#0–#3 ~');
    expect(text).toContain('"request number 0 please read f0.ts"');
    expect(text).toContain("#8–#11 ~");
    expect(text).toContain("Nothing is out of context.");
    expect(s.appended).toEqual([]);
  });

  it("takes whole turns out from the next request, a line naming them in their place", () => {
    setEvict(true);
    const s = session(4);
    expect(tool(s, { drop: ["#1-#4"], note: "f0 and f1 were read; nothing to fix there" })).toContain("Out of context from the next request: #0–#7 (2 turns");
    expect(s.appended.map((e) => [e.customType, e.data.op, e.data.from, e.data.to, e.data.by])).toEqual([[EVICT_ENTRY_TYPE, "evict", 0, 7, "agent"]]);
    const { messages } = sent(s);
    const shown = texts(messages);
    // The two turns' eight messages are gone; one line stands where they were, at the head of turn 2's request
    // (the request never holds two user messages in a row), then turns 2 and 3 as they are.
    expect(shown).toHaveLength(8);
    expect((messages as any[])[0].content.map((p: any) => p.text)).toEqual([shown[0], "request number 2 please read f2.ts"]);
    expect(shown[0]).toBe('[#0–#7 out of context: 2 turns, by the agent. Requests: "request number 0 please read f0.ts"; "request number 1 please read f1.ts". The agent\'s note: f0 and f1 were read; nothing to fix there. Each entry reads back word for word with vcc_recall expand:[0]; vcc_recall query searches them.]');
    // A call and its result leave together: what stays has every result's call.
    const calls = new Set((messages as any[]).flatMap((m) => (m.role === "assistant" ? m.content.map((p: any) => p.id) : [])));
    expect((messages as any[]).filter((m) => m.role === "toolResult").every((m) => calls.has(m.toolCallId))).toBe(true);
    // Never two user messages in a row.
    const roles = (messages as any[]).map((m) => m.role);
    expect(roles.some((r, i) => r === "user" && roles[i + 1] === "user")).toBe(false);
    // The same line on every request, so the provider's cache keeps it.
    expect(texts(sent(s).messages)[0]).toBe(shown[0]);
  });

  it("never takes out the turn running now", () => {
    setEvict(true);
    const s = session(2);
    expect(tool(s, { drop: "#5-#7" })).toContain("Nothing to take out");
    expect(s.appended).toEqual([]);
  });

  it("takes out the oldest turns by count, and brings turns back", () => {
    setEvict(true);
    const s = session(5);
    expect(tool(s, { oldest: 2 })).toContain("#0–#7 (2 turns");
    expect(tool(s, { oldest: 1 })).toContain("#8–#11 (1 turn");
    expect(tool(s, null)).toContain("Out of context:\n  #0–#7 (2 turns)\n  #8–#11 (1 turn)");
    expect(tool(s, { restore: "#0" })).toBe("Back in context from the next request: #0–#7.");
    expect(texts(sent(s).messages)[0]).toBe("request number 0 please read f0.ts");
    expect(texts(sent(s).messages)).toContain(texts(sent(s).messages).find((t) => t.startsWith("[#8–#11 out of context: 1 turn")));
  });
});

describe("the line in place of what is out", () => {
  const work = () => sessionOf([
    { role: "user", content: "fix the rounding in the totals" },
    { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/billing/totals.ts", oldText: "Math.floor(x)", newText: "Math.round(x)" } }] },
    { role: "toolResult", toolCallId: "e1", toolName: "edit", content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "bun test" } }] },
    { role: "toolResult", toolCallId: "b1", toolName: "bash", isError: true, content: [{ type: "text", text: "1 fail: expected 3, got 2" }] },
    { role: "assistant", content: [{ type: "text", text: "The rounding test still fails." }] },
    { role: "user", content: "now run the full suite" },
    { role: "assistant", content: [{ type: "text", text: "Running it." }] },
  ]);

  it("says what the turns did: the files they changed and the calls that failed", () => {
    setEvict(true);
    const s = work();
    tool(s, { drop: "#0" });
    expect(texts(sent(s).messages)[0]).toBe('[#0–#5 out of context: 1 turn, by the agent. Requests: "fix the rounding in the totals". It changed billing/totals.ts; 1 failed call. Each entry reads back word for word with vcc_recall expand:[0]; vcc_recall query searches them.]');
  });

  it("reads the same when omp blanks a result it stands for", () => {
    setEvict(true);
    const s = work();
    tool(s, { drop: "#0" });
    const first = texts(sent(s).messages)[0];
    // As omp's prune does: the old result blanked in place.
    const blanked = s.request().map((m: any) => (m.toolCallId === "b1" ? { ...m, content: [{ type: "text", text: "[Output truncated - 9 tokens]" }] } : m));
    expect(texts(evictRequest(s.host, ompBinding, s.ctx() as any, blanked).messages)[0]).toBe(first);
  });
});

describe("the running turn", () => {
  // One long request: twelve reads of 30,000 chars, the last reporting 80,000 tokens.
  const long = () => {
    const messages: any[] = [{ role: "user", content: "audit every module in the repository" }];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: `m${i}.ts` } }] });
      messages.push({ role: "toolResult", toolCallId: `r${i}`, toolName: "read", content: [{ type: "text", text: `${i}:`.padEnd(30_000, "x") }] });
    }
    messages.at(-2).usage = { input: 80_000, output: 10, cacheRead: 0, cacheWrite: 0 };
    return sessionOf(messages);
  };

  it("lets its older steps leave as the context fills, keeping its request and its newest step", () => {
    setEvict(true);
    const s = long();
    const { messages } = sent(s, 100_000);
    expect(s.appended.map((e) => e.data)).toEqual([expect.objectContaining({ op: "evict", from: 1, by: "auto" })]);
    // The line ends the request it follows, so no two user messages stand in a row.
    const request = (messages as any[])[0].content.map((p: any) => p.text);
    expect(request[0]).toBe("audit every module in the repository");
    expect(request[1]).toStartWith(`[#1–#${s.appended[0].data.to} out of context: older steps of the turn at #0, by omp-vcc as the context filled.`);
    expect((messages as any[])[1].role).toBe("assistant");
    // The newest step stays, and every result that stays has its call.
    expect((messages as any[]).at(-1).toolCallId).toBe("r11");
    const calls = new Set((messages as any[]).flatMap((m) => (m.role === "assistant" ? m.content.map((p: any) => p.id) : [])));
    expect((messages as any[]).filter((m) => m.role === "toolResult").every((m) => calls.has(m.toolCallId))).toBe(true);
  });

  it("gives the compaction no room once only its request and newest step are left", () => {
    setEvict(true);
    const s = sessionOf([
      { role: "user", content: "one request" },
      { role: "assistant", content: [{ type: "toolCall", id: "r0", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolCallId: "r0", toolName: "read", content: [{ type: "text", text: "a" }] },
    ]);
    expect(tool(s, null)).toContain("In context: 1 turn");
    expect(sent(s, 100_000).messages).toBeUndefined();
  });
});

describe("where the line goes", () => {
  it("stands alone only between two messages that cannot carry it, as the core shapes it", () => {
    setEvict(true);
    // A command the user ran (no content to carry text) before the gap, an assistant step after it.
    const s = sessionOf([
      { role: "user", content: "audit the repository" },
      { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "a" }] },
      { role: "bashExecution", command: "ls", output: "a.ts", exitCode: 0 },
      { role: "assistant", content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "b.ts" } }] },
      { role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "r3", name: "read", arguments: { path: "c.ts" } }] },
      { role: "toolResult", toolCallId: "r3", toolName: "read", content: [{ type: "text", text: "c" }] },
    ]);
    record(s, { op: "evict", from: 4, to: 5 });
    const roles = (sent(s).messages as any[]).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "bashExecution", "user", "assistant", "toolResult"]);
    expect(texts(sent(s).messages)[4]).toStartWith("[#4–#5 out of context: older steps of the turn at #0, by the agent.");
  });

  it("puts a message with no #N inside the gap out with it, and one at its edge in", () => {
    setEvict(true);
    const s = session(3);
    const request = s.request();
    // An extension's message inside turn 0, and one between turn 0 and turn 1.
    const inside = { role: "custom", customType: "ext.note", content: "inside", display: false, timestamp: 1 };
    const edge = { role: "custom", customType: "ext.note", content: "edge", display: false, timestamp: 2 };
    request.splice(2, 0, inside);
    request.splice(5, 0, edge);
    tool(s, { drop: "#0" });
    const out = evictRequest(s.host, ompBinding, s.ctx() as any, request).messages as any[];
    expect(out.some((m) => m.content === "inside")).toBe(false);
    // The edge message stays, and carries the line (it is sent as the user's).
    const kept = out.find((m) => Array.isArray(m.content) && m.content.some((p: any) => p.text === "edge"));
    expect(kept.content[0].text).toStartWith("[#0–#3 out of context: 1 turn");
  });
});

describe("a turn whose older steps left while it ran", () => {
  it("keeps its line when it finishes, is listed as in with what of it is out, and a steer is part of it", () => {
    setEvict(true);
    const messages: any[] = [{ role: "user", content: "audit every module in the repository" }];
    for (let i = 0; i < 4; i++) {
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: `m${i}.ts` } }] });
      messages.push({ role: "toolResult", toolCallId: `r${i}`, toolName: "read", content: [{ type: "text", text: `${i}` }] });
      // A steer: the user writes while the agent is still working (omp marks it).
      if (i === 1) messages.push({ role: "user", content: "skip the tests folder please", steering: true });
    }
    const s = sessionOf(messages);
    expect(tool(s, null)).toContain("In context: 1 turn");
    record(s, { op: "evict", from: 1, to: 4 });
    const line = texts(sent(s).messages)[0];
    const running = (sent(s).messages as any[])[0].content.map((p: any) => p.text);
    expect(running[1]).toStartWith("[#1–#4 out of context: older steps of the turn at #0, by the agent.");
    // The turn finishes and a new request comes: the line reads the same, and the turn lists as in, partly out.
    s.entries.push({ type: "message", id: "e99", parentId: "e9", message: { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 2_000_000_000_000 } });
    s.entries.push({ type: "message", id: "e100", parentId: "e99", message: { role: "user", content: "now write the report", timestamp: 2_000_000_000_001 } });
    expect(texts(sent(s).messages)[0]).toBe(line);
    expect((sent(s).messages as any[])[0].content.map((p: any) => p.text)[1]).toBe(running[1]);
    const listing = tool(s, null);
    expect(listing).toContain("In context: 2 turns");
    expect(listing).toContain("(older steps out)");
    expect(listing).toContain("Out of context:\n  #1–#4 (older steps of the turn at #0)");
    // Taking that turn out records only what of it is still in: no range overlaps one out already.
    expect(tool(s, { drop: [0] })).toStartWith("Out of context from the next request: #0, #5–#10 (1 turn");
  });
});

describe("an eviction that does not pay", () => {
  it("is refused to the agent with the run that would pay; near the end, or by the user, it goes", () => {
    setEvict(true);
    const s = session(10);
    // One turn of ten from the oldest end: the provider would read the other nine again for it.
    expect(tool(s, { drop: [0] })).toBe("Not worth it: that frees ~67 tokens but makes the provider read the ~597 after it again, uncached, which a smaller context repays only after many requests. Take out more in one go, from the oldest end: oldest:4.");
    expect(s.appended).toEqual([]);
    expect(tool(s, { oldest: 3 })).toStartWith("Not worth it:");
    expect(tool(s, { oldest: 4 })).toStartWith("Out of context from the next request: #0–#15 (4 turns");
    // The last finished turn: only the running one follows it.
    expect(tool(s, { drop: [32] })).toStartWith("Out of context from the next request: #32–#35");
    // The user decides for themselves.
    expect(call(s, { surface: "command", args: "#16" })).toStartWith("Out of context from the next request: #16–#19");
  });
});

describe("the context's file", () => {
  const mirror = (s: { file: string }) => `${s.file}.vcc-context.md`;
  const edit = (s: { file: string }, f: (text: string) => string) => writeFileSync(mirror(s), f(readFileSync(mirror(s), "utf8")));

  it("holds the request block by block, and what the agent deletes or rewrites leaves the next request", () => {
    setEvict(true);
    const s = session(4);
    sent(s, undefined, true);
    const text = readFileSync(mirror(s), "utf8");
    expect(text).toContain("[[CTX_TURN #0–#3]]\n[user #0] request number 0 please read f0.ts\n[assistant #1]");
    expect(text).toContain("[[CTX_TURN #12–#15 running, stays as it is]]");
    // The agent deletes turn 0 and rewrites turn 1 as what it keeps of it.
    edit(s, (t) => t.replace(/\[\[CTX_TURN #0–#3\]\][\s\S]*?(?=\n\[\[CTX_)/, "").replace(/(\[\[CTX_TURN #4–#7\]\]\n)[\s\S]*?(?=\n\[\[CTX_)/, "$1f1.ts exports totals(); nothing else in it matters."));
    const r = sent(s, undefined, true);
    expect(s.appended.map((e) => [e.data.op, e.data.from, e.data.to, e.data.text])).toEqual([["evict", 0, 3, undefined], ["evict", 4, 7, "f1.ts exports totals(); nothing else in it matters."]]);
    expect(r.notice).toBe("omp-vcc: the agent edited its context's file: #0–#3 out; #4–#7 rewritten.");
    const first = (r.messages as any[])[0].content.map((p: any) => p.text);
    expect(first[1]).toBe("[#0–#7, as you rewrote them in your context's file (each original reads back word for word with vcc_recall expand:[0])]\n(#0–#3 out of context)\nf1.ts exports totals(); nothing else in it matters.");
    // The file now says so, and reading it back as it is changes nothing.
    expect(readFileSync(mirror(s), "utf8")).toContain("[[CTX_OUT #4–#7]]\nf1.ts exports totals(); nothing else in it matters.");
    s.appended.length = 0;
    sent(s, undefined, true);
    expect(s.appended).toEqual([]);
  });

  it("takes the agent's notes between blocks as notes after the turn before, and leaves the running turn as it is", () => {
    setEvict(true);
    const s = session(4);
    sent(s, undefined, true);
    edit(s, (t) => t.replace("\n[[CTX_TURN #12–#15", "\n[[CTX_TURN 9 role=notes]]\nremember: totals() rounds down\n\n[[CTX_TURN #12–#15").replace("[user #12] request number 3", "[user #12] something else"));
    const r = sent(s, undefined, true);
    expect(s.appended.map((e) => [e.data.op, e.data.after, e.data.text])).toEqual([["insert", 11, "remember: totals() rounds down"]]);
    expect(r.notice).toBe("omp-vcc: the agent edited its context's file: 1 note; its edit of the running turn is left out.");
    const reply = (r.messages as any[]).find((m) => m.role === "assistant" && m.content.some((p: any) => p.text === "Read f2.ts."));
    expect(reply.content.map((p: any) => p.text)).toEqual(["Read f2.ts.", "remember: totals() rounds down"]);
    expect(readFileSync(mirror(s), "utf8")).toContain("[[CTX_NOTE after #11]]\nremember: totals() rounds down");
  });

  it("is not written without vcc_context", () => {
    setEvict(false);
    const s = session(2);
    sent(s, undefined, false);
    expect(existsSync(mirror(s))).toBe(false);
  });
});

describe("undo", () => {
  it("reverses the last edit, all of its runs, and an undo again does it again", () => {
    setEvict(false);
    const s = session(6);
    const command = (args: string) => call(s, { surface: "command", args });
    expect(command("undo")).toBe("Nothing to undo: no turn was taken out or brought back.");
    expect(command("#0-#3 #8-#11")).toStartWith("Out of context from the next request: #0–#3, #8–#11");
    expect(command("undo")).toBe("Undone: #0–#3, #8–#11 back in context from the next request.");
    expect(command("list")).toContain("Nothing is out of context.");
    expect(tool(s, { undo: true })).toBe("Undone: #0–#3, #8–#11 out of context again from the next request.");
    expect(command("list")).toContain("Out of context:\n  #0–#3 (1 turn)\n  #8–#11 (1 turn)");
  });
});

describe("the context's size on omp-vcc's own results", () => {
  it("ends the agent's vcc_context, vcc_recall and vcc_pin results while eviction is on, not the user's commands", () => {
    const s = session(3);
    const ctx = { ...s.ctx(100_000), getContextUsage: () => ({ tokens: 41_808 }) } as any;
    const readout = "[context: ~41808 tokens, 50% of where the host compacts (~83616)]";
    setEvict(true);
    expect(evict(s.host, ompBinding, ctx, { surface: "tool", params: null })).toEndWith(`\n${readout}`);
    expect(evict(s.host, ompBinding, ctx, { surface: "command", args: "list" })).not.toContain("[context:");
    expect(executePin({ note: "a note" }, s.host, ctx.sessionManager, ctx)).toEndWith(`\n${readout}`);
    setEvict(false);
    expect(executePin({ note: "another note" }, s.host, ctx.sessionManager, ctx)).not.toContain("[context:");
  });
});

describe("turn numbers in view", () => {
  it("each request in the context starts with its turn's #N while vcc_context is there, the same on every request", () => {
    setEvict(true);
    const s = session(3);
    record(s, { op: "evict", from: 0, to: 3 });
    const out = sent(s, undefined, true).messages as any[];
    const requests = out.filter((m) => m.role === "user").map((m) => m.content.map((p: any) => p.text));
    // The line for turn 0 rides on turn 1's request, before its mark.
    expect(requests[0][0]).toBe(header(s));
    expect(requests[0][1]).toStartWith("[#0–#3 out of context");
    expect(requests[0].slice(2)).toEqual(["[#4]", "request number 1 please read f1.ts"]);
    expect(requests[1]).toEqual(["[#8]", "request number 2 please read f2.ts"]);
    expect(sent(s, undefined, true).messages).toEqual(out);
    // Without the tool, nothing is marked.
    expect(texts(sent(s, undefined, false).messages).filter((t) => t === "[#8]")).toEqual([]);
  });
});

describe("pinned notes when turns leave", () => {
  it("stand first in the request, in one block, as of the last edit of the context", () => {
    setEvict(true);
    const s = session(4);
    const pinAt = (after: number, data: Record<string, unknown>) =>
      s.entries.splice(after + 1, 0, { type: "custom", id: `p${String(data.id)}`, parentId: null, customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", by: "agent", ...data } });
    // Pinned in turn 3, turn 1 and turn 0 (inserted from the end so the positions hold), and one carried from the last session.
    pinAt(13, { id: 3, name: "test-cmd", text: "bun test --isolate", at: 13 });
    pinAt(5, { id: 2, name: "test-cmd", text: "bun test", at: 5 });
    pinAt(1, { id: 1, text: "sessions live in SQLite", at: 1 });
    pinAt(-1, { id: 9, name: "plan", text: "ship v2", at: null, from: "aaaa1111" });
    const first = (sent(s, undefined, true).messages as any[])[0].content.map((p: any) => p.text);
    // Nothing out: the notes pinned in the conversation are in it, in their calls; the block holds what was carried in.
    expect(first).toEqual([
      header(s) + "\n[Pinned notes carried from the last session (vcc_pin; a name pinned again replaces its note; any pinned since are in the conversation):\n- [9] plan: ship v2 (agent, from session aaaa1111)]",
      "[#0]", "request number 0 please read f0.ts",
    ]);
    // Turns out: the edit takes up every note as it reads then, and the block stands first, the same on every request.
    record(s, { op: "evict", from: 0, to: 7 });
    const out = (sent(s, undefined, true).messages as any[])[0].content.map((p: any) => p.text);
    expect(out[0]).toBe(`${header(s)}\n` + "[Pinned notes, as of #15 (vcc_pin; a name pinned again replaces its note; any pinned since are in the conversation):\n- [1] sessions live in SQLite (agent, #1)\n- [3] test-cmd: bun test --isolate (agent, #13)\n- [9] plan: ship v2 (agent, from session aaaa1111)]");
    expect(out[1]).toStartWith("[#0–#7 out of context: 2 turns");
    expect((sent(s, undefined, true).messages as any[])[0].content.map((p: any) => p.text)).toEqual(out);
    // A note pinned after the edit leaves the block as it is: it is in the conversation.
    s.host.appendEntry(PIN_ENTRY_TYPE, { v: 1, op: "add", id: 4, text: "a later note", by: "agent", at: 15 });
    expect((sent(s, undefined, true).messages as any[])[0].content.map((p: any) => p.text)).toEqual(out);
    expect(tool(s, null)).toContain("Pinned (vcc_pin; a name pinned again replaces its note):\n  [1] sessions live in SQLite (agent, #1)\n  [3] test-cmd: bun test --isolate (agent, #13)\n  [4] a later note (agent, #15)\n  [9] plan: ship v2 (agent, from session aaaa1111)");
  });

  it("are not added with eviction off and nothing out: the summary carries them", () => {
    setEvict(false);
    const s = session(3);
    s.host.appendEntry(PIN_ENTRY_TYPE, { v: 1, op: "add", id: 1, text: "a note", by: "user", at: 1 });
    expect(sent(s).messages).toBeUndefined();
  });
});

describe("/omp-vcc-evict", () => {
  const command = (s: ReturnType<typeof session>, args: string) => call(s, { surface: "command", args });

  it("takes out the oldest half with no text, a number of turns, all, or a range; and restores", () => {
    setEvict(false);
    const s = session(5);
    expect(command(s, "")).toContain("#0–#7 (2 turns");
    expect(command(s, "1")).toContain("#8–#11 (1 turn");
    expect(command(s, "restore all")).toBe("Back in context from the next request: #0–#7, #8–#11.");
    expect(command(s, "all")).toContain("#0–#15 (4 turns");
    expect(command(s, "list")).toContain("In context: 1 turn");
    expect(command(s, "restore #3")).toBe("Back in context from the next request: #0–#15.");
    expect(command(s, "#3-#4")).toContain("#0–#7 (2 turns");
    expect(command(s, "whatever")).toContain("Not understood: whatever.");
    expect(s.appended.map((e) => e.data.by).every((b) => b === "user")).toBe(true);
  });
});

describe("the request hook", () => {
  it("leaves out what the evict command took, with the evict setting off too", async () => {
    setEvict(false);
    const s = session(4);
    expect(call(s, { surface: "command", args: "2" })).toContain("#0–#7 (2 turns");
    let handler: any;
    registerEviction({ on: (name: string, fn: any) => { if (name === "context") handler = fn; }, appendEntry: s.host.appendEntry, sendMessage: () => {} } as any, ompBinding as any, { registered: false });
    const result = await handler({ type: "context", messages: s.request() }, { ...s.ctx(), ui: { notify: () => {} } });
    expect(texts(result.messages)[0]).toStartWith("[#0–#7 out of context: 2 turns, by the user.");
  });

  it("leaves the request alone without reading the session for it, with the setting off and nothing recorded", async () => {
    setEvict(false);
    const s = session(4);
    let handler: any;
    registerEviction({ on: (name: string, fn: any) => { if (name === "context") handler = fn; }, appendEntry: s.host.appendEntry, sendMessage: () => {} } as any, ompBinding as any, { registered: false });
    // The request's snapshot reads the session file; here nothing may need it.
    let read = 0;
    const ctx = () => ({ ...s.ctx(), sessionManager: { ...s.ctx().sessionManager, getSessionFile: () => { read++; return undefined; } } });
    expect(await handler({ type: "context", messages: s.request() }, ctx())).toBeUndefined();
    expect(read).toBe(0);
    // Once an eviction is recorded, every request is read for it.
    call(s, { surface: "command", args: "1" });
    expect(await handler({ type: "context", messages: s.request() }, ctx())).toBeDefined();
    expect(read).toBeGreaterThan(0);
  });
});

describe("as the context fills", () => {
  // A 100K window: omp compacts at 83,616 tokens; past 85% of that the oldest turns leave, down to half.
  it("takes out the oldest finished turns, by omp-vcc, and says so", () => {
    setEvict(true);
    const s = session(10, 30_000, 80_000);
    const { messages, notice } = sent(s, 100_000);
    expect(s.appended).toHaveLength(1);
    expect(s.appended[0].data).toMatchObject({ op: "evict", from: 0, by: "auto" });
    const to = s.appended[0].data.to;
    expect(notice).toContain(`#0–#${to} out · by omp-vcc as the context filled`);
    const shown = texts(messages);
    expect(shown[0]).toContain("by omp-vcc as the context filled");
    // What stays is at most half of the trigger, by the same estimate.
    const after = Number(notice!.match(/→ ~(\d+) tokens/)![1]);
    expect(after).toBeLessThanOrEqual(83_616 / 2);
    // The next request takes nothing more out.
    s.appended.length = 0;
    sent(s, 100_000);
    expect(s.appended).toEqual([]);
  });

  it("estimates from the ledger as the last request saw it: a turn brought back since was not sent then", () => {
    setEvict(true);
    // Turn 0 was out when the request that reported 80,000 tokens was made, and has been brought back since.
    const s = session(10, 30_000, 80_000);
    s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, op: "evict", from: 0, to: 3, by: "user", at: 4 });
    s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, op: "restore", from: 0, to: 3, by: "user", at: 50 });
    const restored = Number(sent(s, 100_000).notice!.match(/Context ~(\d+)/)![1]);
    // The same session with nothing ever out: the 80,000 counted every turn.
    const plain = Number(sent(session(10, 30_000, 80_000), 100_000).notice!.match(/Context ~(\d+)/)![1]);
    // Turn 0 (about 7,500 tokens) was not in the 80,000, so the context now holds that much more.
    expect(restored - plain).toBeGreaterThan(7_000);
  });

  it("tells the model how full the context is once per tenth of the trigger past half, as a message of its own", () => {
    setEvict(true);
    // 10 turns of 20,000 chars, 50,000 tokens counted: past half of 83,616, short of 85%.
    const s = session(10, 20_000, 50_000);
    const first = sent(s, 100_000, true);
    // Nothing leaves the request (its turns only gain their #N): the note is stored and sent before the next model call.
    expect((first.messages as any[]).length).toBe(s.request().length);
    expect(first.note).toMatch(/^\[omp-vcc: the context is past \d0% of where the host compacts \(~83616 tokens\); past 85% the oldest turns leave by themselves\. vcc_context lists what is in it and takes old turns out, with a note of what to keep\.\]$/);
    expect(s.appended.map((e) => e.data.op)).toEqual(["budget"]);
    // The same tenth again: nothing more is said.
    expect(sent(s, 100_000, true).note).toBeUndefined();
    // Without vcc_context the note would name a tool that is not there; below half nothing is said.
    expect(sent(session(10, 20_000, 50_000), 100_000, false).note).toBeUndefined();
    expect(sent(session(10, 1_000, 20_000), 100_000, true).note).toBeUndefined();
  });

  it("tells again from half once the agent or the user shrank the context, not after omp-vcc's own eviction", () => {
    setEvict(true);
    const s = session(10, 20_000, 50_000);
    expect(sent(s, 100_000, true).note).toBeDefined();
    record(s, { op: "evict", from: 0, to: 3, by: "auto" });
    expect(sent(s, 100_000, true).note).toBeUndefined();
    record(s, { op: "evict", from: 4, to: 7, by: "agent" });
    expect(sent(s, 100_000, true).note).toBeDefined();
  });

  it("says nothing of the context's size when nothing can leave it", () => {
    setEvict(true);
    // One turn: its request and its newest step stay, so vcc_context could take nothing.
    const s = sessionOf([
      { role: "user", content: "one request" },
      { role: "assistant", content: [{ type: "toolCall", id: "r0", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolCallId: "r0", toolName: "read", content: [{ type: "text", text: "x".repeat(200_000) }], },
    ]);
    s.entries[1].message.usage = { input: 60_000, output: 1, cacheRead: 0, cacheWrite: 0 };
    expect(sent(s, 100_000, true).note).toBeUndefined();
  });

  it("does nothing below 85% of the trigger, or with the setting off", () => {
    setEvict(true);
    const below = session(10, 1_000, 20_000);
    expect(sent(below, 100_000)).toEqual({ messages: undefined, notice: undefined });
    setEvict(false);
    const off = session(10, 30_000, 80_000);
    expect(sent(off, 100_000)).toEqual({ messages: undefined, notice: undefined });
    expect(off.appended).toEqual([]);
  });
});
