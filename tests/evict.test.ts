// Old turns out of the context whole (lisp/src/evict.lisp): taken out by the
// agent (keel_context), the user (/keel-evict) or keel past 85% of the
// trigger, left out of every later request with one line in their place, and
// brought back; the session file keeps them, and keel_recall reads them back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { EVICT_ENTRY_TYPE, PIN_ENTRY_TYPE } from "./support/names";
import { callCommand, callTool, executePin, fakeHost, requestContext } from "./support/binding";
import { writeJsonl, freshDir } from "./support/session-files";

let dir: string;
const prev = process.env.KEEL_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-evict-"));
  process.env.KEEL_CONFIG_PATH = join(dir, "keel-config.json");
});
afterAll(() => {
  if (prev === undefined) delete process.env.KEEL_CONFIG_PATH;
  else process.env.KEEL_CONFIG_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});
const setEvict = (on: boolean) => writeFileSync(process.env.KEEL_CONFIG_PATH!, JSON.stringify({ evict: on }));

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
      const e = { type: "custom", id: `x${entries.length}`, parentId: entries.at(-1)?.id ?? null, customType, data };
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

/** A keel_context call, or the text of /keel-evict. */
type EvictCall = { surface: "tool"; params: unknown } | { surface: "command"; args: string };
/** The call through keel, its entries appended through HOST: what the agent or the user is told. */
const evict = (host: { appendEntry: (t: string, d?: unknown) => void }, ctx: any, c: EvictCall): string =>
  c.surface === "tool" ? callTool("keel_context", c.params, ctx, host) : callCommand("evict", c.args, ctx, host)!;
const call = (s: ReturnType<typeof session>, c: EvictCall) => evict(s.host, s.ctx(), c);
const tool = (s: ReturnType<typeof session>, params: unknown) => call(s, { surface: "tool", params });
const sent = (s: ReturnType<typeof session>, window?: number, tool = false) => requestContext(s.request(), s.ctx(window), s.host, tool);
const record = (s: ReturnType<typeof session>, op: Record<string, unknown>) => s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, by: "agent", at: 99, ...op });
/** The line the request starts with while keel_context is there: where the context's file is. */
const header = (s: { file: string }) => `[Your context is mirrored in ${s.file}.keel-context.md, block by block as this request sends it. Edit that file to change what you hold: delete a [[CTX_TURN]] block to take its turn out, replace its text with what to keep of it, or write notes of your own between blocks. The next request sends what the file says. The session keeps every word (keel_recall expand:[N] reads any original back); the running turn stays as it is.]`;
const texts = (messages: unknown[] | undefined) => (messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : m.content?.[0]?.text ?? m.content?.[0]?.type ?? ""));

describe("keel_context", () => {
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
    expect(shown[0]).toBe('[#0–#7 out of context: 2 turns, by the agent. Requests: "request number 0 please read f0.ts"; "request number 1 please read f1.ts". The agent\'s note: f0 and f1 were read; nothing to fix there. Each entry reads back word for word with keel_recall expand:[0]; keel_recall query searches them.]');
    // A call and its result leave together: what stays has every result's call.
    const calls = new Set((messages as any[]).flatMap((m) => (m.role === "assistant" ? m.content.map((p: any) => p.id) : [])));
    expect((messages as any[]).filter((m) => m.role === "toolResult").every((m) => calls.has(m.toolCallId))).toBe(true);
    // Never two user messages in a row.
    const roles = (messages as any[]).map((m) => m.role);
    expect(roles.some((r, i) => r === "user" && roles[i + 1] === "user")).toBe(false);
    // The same line on every request, so the provider's cache keeps it.
    expect(texts(sent(s).messages)[0]).toBe(shown[0]);
  });

  it("keeps out what keel took out as omp-vcc, and brings it back", () => {
    setEvict(true);
    const s = session(4);
    s.host.appendEntry("omp-vcc.evict", { v: 1, op: "evict", from: 0, to: 7, by: "agent", at: 99 });
    expect(texts(sent(s).messages)[0]).toStartWith("[#0–#7 out of context: 2 turns, by the agent.");
    expect(tool(s, { restore: "#0" })).toBe("Back in context from the next request: #0–#7.");
    // Nothing is out now: the request goes as the host built it.
    expect(sent(s).messages).toBeUndefined();
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
    expect(texts(sent(s).messages)[0]).toBe('[#0–#5 out of context: 1 turn, by the agent. Requests: "fix the rounding in the totals". It changed billing/totals.ts; 1 failed call. Each entry reads back word for word with keel_recall expand:[0]; keel_recall query searches them.]');
  });

  it("reads the same when omp blanks a result it stands for", () => {
    setEvict(true);
    const s = work();
    tool(s, { drop: "#0" });
    const first = texts(sent(s).messages)[0];
    // As omp's prune does: the old result blanked in place.
    const blanked = s.request().map((m: any) => (m.toolCallId === "b1" ? { ...m, content: [{ type: "text", text: "[Output truncated - 9 tokens]" }] } : m));
    expect(texts(requestContext(blanked, s.ctx(), s.host).messages)[0]).toBe(first);
  });
});

describe("a repeated tool output", () => {
  // The same test run three times with the same failure, and once more after a fix.
  const reruns = () => {
    const fail = `bun test tests/billing\n1 fail: totals rounding\n${"  at roundTotals (src/billing/totals.ts:42)\n".repeat(20)}`;
    const messages: any[] = [{ role: "user", content: "fix the rounding" }];
    for (const [i, out] of [fail, fail, fail, "12 pass"].entries()) {
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: "bun test tests/billing" } }] });
      messages.push({ role: "toolResult", toolCallId: `t${i}`, toolName: "bash", isError: out !== "12 pass", content: [{ type: "text", text: out }] });
    }
    return sessionOf(messages);
  };

  it("is sent as a line naming the first, every call kept", () => {
    setEvict(true);
    const s = reruns();
    const all = sent(s, 100_000).messages as any[];
    const results = all.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(4);
    expect(results[0].content[0].text).toStartWith("bun test tests/billing\n1 fail");
    expect(results[1].content).toEqual([{ type: "text", text: "[#4: the same output as #2, word for word. keel_recall expand:[4] reads it.]" }]);
    expect(results[2].content[0].text).toBe("[#6: the same output as #2, word for word. keel_recall expand:[6] reads it.]");
    // A short output, and one that differs, go as they are.
    expect(results[3].content[0].text).toBe("12 pass");
    // Nothing is recorded: the line is made again, the same, for each request.
    expect(s.appended).toEqual([]);
    expect(texts(sent(s, 100_000).messages)).toEqual(texts(all));
  });

  it("goes as it is with eviction off", () => {
    setEvict(false);
    expect(sent(reruns(), 100_000).messages).toBeUndefined();
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

  it("lets its big results leave on their own as the context fills, each call kept, its request and newest step whole", () => {
    setEvict(true);
    const s = long();
    const { messages } = sent(s, 100_000);
    // Each result is ~7,500 tokens, past a sixteenth of the 83,616 trigger: results go, one #N each, oldest first.
    const ops = s.appended.map((e) => e.data);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((op: any) => op.op === "evict" && op.by === "auto" && op.from === op.to && op.from % 2 === 0)).toBe(true);
    expect(ops[0].from).toBe(2);
    // Every call stays, each with its result: the ones out hold a line in place of their content.
    const all = messages as any[];
    expect(all.filter((m) => m.role === "assistant")).toHaveLength(12);
    expect(all.filter((m) => m.role === "toolResult")).toHaveLength(12);
    const out = all.find((m) => m.toolCallId === "r0");
    expect(out.content).toEqual([{ type: "text", text: "[#2 out of context: this read result, on its own; its call stays. It reads back word for word with keel_recall expand:[2].]" }]);
    expect(all[0].content).toBe("audit every module in the repository");
    // The newest step stays whole.
    expect(all.at(-1).toolCallId).toBe("r11");
    expect(all.at(-1).content[0].text).toStartWith("11:x");
    // Once the turn has finished, the context's file shows the line too, inside the turn's block.
    s.entries.push({ type: "message", id: "next", parentId: s.entries.at(-1).id, message: { role: "user", content: "now the tests", timestamp: 1_800_000_000_000 } });
    sent(s, 100_000, true);
    expect(readFileSync(`${s.file}.keel-context.md`, "utf8")).toContain("[toolResult #2] [#2 out of context: this read result, on its own;");
  });

  it("lets its older steps leave whole when no result is big on its own", () => {
    setEvict(true);
    // Sixty reads of 5,000 chars: none near a sixteenth of the trigger, together past 85% of it.
    const messages: any[] = [{ role: "user", content: "audit every module in the repository" }];
    for (let i = 0; i < 60; i++) {
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: `m${i}.ts` } }] });
      messages.push({ role: "toolResult", toolCallId: `r${i}`, toolName: "read", content: [{ type: "text", text: `${i}:`.padEnd(5_000, "x") }] });
    }
    messages.at(-2).usage = { input: 80_000, output: 10, cacheRead: 0, cacheWrite: 0 };
    const s = sessionOf(messages);
    const { messages: request } = sent(s, 100_000);
    expect(s.appended.map((e) => e.data)).toEqual([expect.objectContaining({ op: "evict", from: 1, by: "auto" })]);
    const first = (request as any[])[0].content.map((p: any) => p.text);
    expect(first[1]).toStartWith(`[#1–#${s.appended[0].data.to} out of context: older steps of the turn at #0, by keel as the context filled.`);
    // The newest step stays, and every result that stays has its call.
    expect((request as any[]).at(-1).toolCallId).toBe("r59");
    const calls = new Set((request as any[]).flatMap((m) => (m.role === "assistant" ? m.content.map((p: any) => p.id) : [])));
    expect((request as any[]).filter((m) => m.role === "toolResult").every((m) => calls.has(m.toolCallId))).toBe(true);
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
    const out = requestContext(request, s.ctx(), s.host).messages as any[];
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
    // No prices yet (too few requests): a cache at a tenth of the price, 20 requests ahead.
    expect(tool(s, { drop: [0] })).toBe("Not worth it: that frees ~67 tokens but makes the provider read the ~597 after it again; assuming a cache at 10% of the input price, over 20 more requests, a drop must free 45% of what it makes it read again. Take out more in one go, from the oldest end (oldest:4), or send force: true to take these out anyway (when you were asked to, or what they hold is done with).");
    expect(s.appended).toEqual([]);
    expect(tool(s, { drop: [0], force: true })).toStartWith("Out of context from the next request: #0–#3");
    expect(tool(s, { undo: true })).toStartWith("Undone: #0–#3 back in context");
    expect(tool(s, { oldest: 3 })).toStartWith("Not worth it:");
    expect(tool(s, { oldest: 4 })).toStartWith("Out of context from the next request: #0–#15 (4 turns");
    // The last finished turn: only the running one follows it.
    expect(tool(s, { drop: [32] })).toStartWith("Out of context from the next request: #32–#35");
    // The user decides for themselves.
    expect(call(s, { surface: "command", args: "#16" })).toStartWith("Out of context from the next request: #16–#19");
  });
});

describe("the context's file", () => {
  const mirror = (s: { file: string }) => `${s.file}.keel-context.md`;
  const edit = (s: { file: string }, f: (text: string) => string) => writeFileSync(mirror(s), f(readFileSync(mirror(s), "utf8")));

  it("holds the request block by block, and what the agent deletes or rewrites leaves the next request", () => {
    setEvict(true);
    const s = session(4);
    sent(s, undefined, true);
    const text = readFileSync(mirror(s), "utf8");
    expect(text).toContain("[[CTX_TURN #0–#3]]\n[user #0] request number 0 please read f0.ts\n[assistant #1]");
    expect(text).toContain("[[CTX_TURN #12 running, stays as it is]]\n(the turn running now: it stays as it is, and is not in this file, so the file holds still while you edit it)\n");
    expect(text).not.toContain("[user #12]");
    // The agent deletes turn 0 and rewrites turn 1 as what it keeps of it.
    edit(s, (t) => t.replace(/\[\[CTX_TURN #0–#3\]\][\s\S]*?(?=\n\[\[CTX_)/, "").replace(/(\[\[CTX_TURN #4–#7\]\]\n)[\s\S]*?(?=\n\[\[CTX_)/, "$1f1.ts exports totals(); nothing else in it matters."));
    const r = sent(s, undefined, true);
    expect(s.appended.map((e) => [e.data.op, e.data.from, e.data.to, e.data.text])).toEqual([["evict", 0, 3, undefined], ["evict", 4, 7, "f1.ts exports totals(); nothing else in it matters."]]);
    expect(r.notice).toBe("keel: the agent edited its context's file: #0–#3 out; #4–#7 rewritten.");
    const first = (r.messages as any[])[0].content.map((p: any) => p.text);
    expect(first[1]).toBe("[#0–#7, as you rewrote them in your context's file (each original reads back word for word with keel_recall expand:[0])]\n(#0–#3 out of context)\nf1.ts exports totals(); nothing else in it matters.");
    // The file now says so, and reading it back as it is changes nothing.
    expect(readFileSync(mirror(s), "utf8")).toContain("[[CTX_OUT #4–#7]]\nf1.ts exports totals(); nothing else in it matters.");
    s.appended.length = 0;
    sent(s, undefined, true);
    expect(s.appended).toEqual([]);
    // Rewriting what is out again, then undoing it: the earlier rewrite stands again, whole.
    edit(s, (t) => t.replace("f1.ts exports totals(); nothing else in it matters.", "f1.ts: totals() only."));
    sent(s, undefined, true);
    expect(readFileSync(mirror(s), "utf8")).toContain("[[CTX_OUT #4–#7]]\nf1.ts: totals() only.");
    expect(call(s, { surface: "command", args: "undo" })).toBe("Undone: #4–#7 back in context; #4–#7 out of context again from the next request.");
    sent(s, undefined, true);
    expect(readFileSync(mirror(s), "utf8")).toContain("[[CTX_OUT #4–#7]]\nf1.ts exports totals(); nothing else in it matters.");
    // And the agent's whole first edit undone: both turns back.
    expect(call(s, { surface: "command", args: "undo" })).toStartWith("Undone:");
  });

  it("takes the agent's notes between blocks as notes after the turn before, and leaves the running turn as it is", () => {
    setEvict(true);
    const s = session(4);
    sent(s, undefined, true);
    edit(s, (t) => t.replace("\n[[CTX_TURN #12 running", "\n[[CTX_TURN 9 role=notes]]\nremember: totals() rounds down\n\n[[CTX_TURN #12 running").replace("(the turn running now", "something else (the turn running now"));
    const r = sent(s, undefined, true);
    expect(s.appended.map((e) => [e.data.op, e.data.after, e.data.text])).toEqual([["insert", 11, "remember: totals() rounds down"]]);
    expect(r.notice).toBe("keel: the agent edited its context's file: 1 note; its edit of the running turn is left out.");
    const reply = (r.messages as any[]).find((m) => m.role === "assistant" && m.content.some((p: any) => p.text === "Read f2.ts."));
    expect(reply.content.map((p: any) => p.text)).toEqual(["Read f2.ts.", "remember: totals() rounds down"]);
    expect(readFileSync(mirror(s), "utf8")).toContain("[[CTX_NOTE after #11]]\nremember: totals() rounds down");
  });

  it("reads a script's rewrite of the whole file as what changed: whitespace is no edit, a block named twice is one", () => {
    setEvict(true);
    const s = session(4);
    sent(s, undefined, true);
    // Every line trimmed and blank lines dropped, as a script that rejoins the file does: nothing changed.
    edit(s, (t) => t.split("\n").map((l) => l.trim()).filter(Boolean).join("\n"));
    sent(s, undefined, true);
    expect(s.appended).toEqual([]);
    // Turn 1's block written twice with the same new text: one rewrite of it.
    edit(s, (t) => t.replace(/(\[\[CTX_TURN #4–#7\]\]\n)[\s\S]*?(?=\n\[\[CTX_)/, "$1f1 only.\n\n$1f1 only."));
    sent(s, undefined, true);
    expect(s.appended.map((e) => [e.data.op, e.data.from, e.data.to, e.data.text])).toEqual([["evict", 4, 7, "f1 only."]]);
  });

  it("is not written without keel_context", () => {
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

describe("the context's size on keel's own results", () => {
  it("ends the agent's keel_context, keel_recall and keel_pin results while eviction is on, not the user's commands", () => {
    const s = session(3);
    const ctx = { ...s.ctx(100_000), getContextUsage: () => ({ tokens: 41_808 }) } as any;
    const readout = "[context: ~41808 tokens, 50% of where the host compacts (~83616); ~41808 left]";
    setEvict(true);
    expect(evict(s.host, ctx, { surface: "tool", params: null })).toEndWith(`\n${readout}`);
    expect(evict(s.host, ctx, { surface: "command", args: "list" })).not.toContain("[context:");
    expect(executePin({ note: "a note" }, s.host, ctx.sessionManager, ctx)).toEndWith(`\n${readout}`);
    setEvict(false);
    expect(executePin({ note: "another note" }, s.host, ctx.sessionManager, ctx)).not.toContain("[context:");
  });
});

describe("when an eviction pays, by the session's own prices", () => {
  /** SESSION(10)'s messages, every assistant message with this usage. */
  const priced = (usage: Record<string, unknown>) => {
    const messages: any[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `request number ${i} please read f${i}.ts` });
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i}.ts` } }], usage });
      messages.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: `${i}:`.padEnd(200, "x") }] });
      messages.push({ role: "assistant", content: [{ type: "text", text: `Read f${i}.ts.` }], usage });
    }
    return sessionOf(messages);
  };

  it("counts a cache at the price the session paid, over as many requests as it has made", () => {
    setEvict(true);
    // An input token at 1e-6, a cached one at a quarter of that, 20 requests: a drop must free (1 - 0.25) / (0.25 x 20) = 15%.
    const s = priced({ input: 1000, cacheRead: 5000, cacheWrite: 0, output: 10, cost: { input: 0.001, cacheRead: 0.00125, cacheWrite: 0, output: 0 } });
    expect(tool(s, { drop: [0] })).toBe("Not worth it: that frees ~67 tokens but makes the provider read the ~597 after it again; at this session's prices, a cached token 25% of an input token's, over 20 more requests, a drop must free 15% of what it makes it read again. Take out more in one go, from the oldest end (oldest:2), or send force: true to take these out anyway (when you were asked to, or what they hold is done with).");
    expect(tool(s, { oldest: 2 })).toStartWith("Out of context from the next request: #0–#7");
  });

  it("lets any drop through where the provider caches nothing", () => {
    setEvict(true);
    const s = priced({ input: 6000, cacheRead: 0, cacheWrite: 0, output: 10, cost: { input: 0.006, cacheRead: 0, cacheWrite: 0, output: 0 } });
    expect(tool(s, { drop: [0] })).toStartWith("Out of context from the next request: #0–#3");
  });
});

describe("chars per token, measured on the request", () => {
  it("comes from two requests the provider counted, is kept for the model, and sizes keel_context's listing", () => {
    setEvict(true);
    const messages: any[] = [];
    // 10 turns of 3,000 chars; each answer's prompt grows by 1,000 tokens a turn: 3 chars a token.
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `request ${i} `.padEnd(1000, "x") });
      messages.push({ role: "assistant", content: [{ type: "text", text: "".padEnd(2000, "y") }], usage: { input: 5000 + 1000 * i, cacheRead: 0, cacheWrite: 0, output: 1 } });
    }
    const s = sessionOf(messages);
    sent(s, 100_000, true);
    const limits = JSON.parse(readFileSync(join(dirname(process.env.KEEL_CONFIG_PATH!), "keel-models.json"), "utf8"));
    expect(limits["p/m"].charsPerToken).toBe(3);
    // The listing reads it: a turn of 3,000 chars is ~1,000 tokens, not the 750 of 4 chars a token.
    expect(evict(s.host, s.ctx(100_000), { surface: "tool", params: null })).toContain("#16–#17 ~1000 tokens");
    // What this model measured stays with this test.
    rmSync(join(dirname(process.env.KEEL_CONFIG_PATH!), "keel-models.json"), { force: true });
  });

  it("is read from the low side of what was measured lately, so the tokens it estimates are an upper bound", () => {
    setEvict(true);
    const file = join(dirname(process.env.KEEL_CONFIG_PATH!), "keel-models.json");
    // Measured at 4 chars a token now, at 2 a while ago (text in another script, say).
    writeFileSync(file, JSON.stringify({ "p/m": { charsPerToken: 4, charsPerTokenSeen: [2, 4] } }));
    const s = session(4, 3_000);
    // A turn of ~3,000 chars counts as ~1,500 tokens, not the 750 the latest value alone would say.
    expect(evict(s.host, s.ctx(100_000), { surface: "tool", params: null })).toMatch(/#0–#3 ~15\d\d tokens/);
    rmSync(file, { force: true });
  });

  it("keeps each value it moved to, the last eight", () => {
    setEvict(true);
    const file = join(dirname(process.env.KEEL_CONFIG_PATH!), "keel-models.json");
    writeFileSync(file, JSON.stringify({ "p/m": { charsPerToken: 4, charsPerTokenSeen: [5, 5.5, 6, 4.5, 5, 6, 5.5, 4] } }));
    const messages: any[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `request ${i} `.padEnd(1000, "x") });
      messages.push({ role: "assistant", content: [{ type: "text", text: "".padEnd(2000, "y") }], usage: { input: 5000 + 1000 * i, cacheRead: 0, cacheWrite: 0, output: 1 } });
    }
    sent(sessionOf(messages), 100_000, true);
    expect(JSON.parse(readFileSync(file, "utf8"))["p/m"]).toMatchObject({ charsPerToken: 3, charsPerTokenSeen: [5.5, 6, 4.5, 5, 6, 5.5, 4, 3] });
    rmSync(file, { force: true });
  });
});

describe("the dashboard at the end of every request", () => {
  /** The text the request ends with. */
  const tail = (messages: unknown[] | undefined) => {
    const last: any = (messages ?? []).at(-1);
    return typeof last?.content === "string" ? last.content : last?.content?.at(-1)?.text ?? "";
  };

  it("says how full the context is, what fills it and what is out, with keel_context there", () => {
    setEvict(true);
    const s = session(6, 4_000, 20_000);
    const first = tail(sent(s, 100_000, true).messages);
    expect(first).toMatch(/^\[context: ~\d+ tokens, \d+% of where the host compacts \(~83616\), ~\d+ left · 6 turns in, largest #\d+–#\d+ ~\d+, #\d+–#\d+ ~\d+, #\d+–#\d+ ~\d+ · nothing out · keel_context drops or restores turns by #N\]$/);
    // A turn out: the dashboard says so, and counts it out of what is in.
    record(s, { op: "evict", from: 0, to: 3 });
    expect(tail(sent(s, 100_000, true).messages)).toContain("· 5 turns in, largest ");
    expect(tail(sent(s, 100_000, true).messages)).toContain("· 1 turn out (#0–#3) ·");
  });

  it("is not there without keel_context, and is never kept: the session file has none", () => {
    setEvict(true);
    const s = session(6, 4_000, 20_000);
    expect(tail(sent(s, 100_000, false).messages ?? s.request())).not.toContain("[context:");
    sent(s, 100_000, true);
    expect(JSON.stringify(s.entries)).not.toContain("[context:");
  });
});

describe("turn numbers in view", () => {
  it("each request in the context starts with its turn's #N while keel_context is there, the same on every request", () => {
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
      header(s) + "\n[Pinned notes carried from the last session (keel_pin; a name pinned again replaces its note; any pinned since are in the conversation):\n- [9] plan: ship v2 (agent, from session aaaa1111)]",
      "[#0]", "request number 0 please read f0.ts",
    ]);
    // Turns out: the edit takes up every note as it reads then, and the block stands first, the same on every request.
    record(s, { op: "evict", from: 0, to: 7 });
    const out = (sent(s, undefined, true).messages as any[])[0].content.map((p: any) => p.text);
    expect(out[0]).toBe(`${header(s)}\n` + "[Pinned notes, as of #15 (keel_pin; a name pinned again replaces its note; any pinned since are in the conversation):\n- [1] sessions live in SQLite (agent, #1)\n- [3] test-cmd: bun test --isolate (agent, #13)\n- [9] plan: ship v2 (agent, from session aaaa1111)]");
    expect(out[1]).toStartWith("[#0–#7 out of context: 2 turns");
    expect((sent(s, undefined, true).messages as any[])[0].content.map((p: any) => p.text)).toEqual(out);
    // A note pinned after the edit leaves the block as it is: it is in the conversation.
    s.host.appendEntry(PIN_ENTRY_TYPE, { v: 1, op: "add", id: 4, text: "a later note", by: "agent", at: 15 });
    expect((sent(s, undefined, true).messages as any[])[0].content.map((p: any) => p.text)).toEqual(out);
    expect(tool(s, null)).toContain("Pinned (keel_pin; a name pinned again replaces its note):\n  [1] sessions live in SQLite (agent, #1)\n  [3] test-cmd: bun test --isolate (agent, #13)\n  [4] a later note (agent, #15)\n  [9] plan: ship v2 (agent, from session aaaa1111)");
  });

  it("are not added with eviction off and nothing out: the summary carries them", () => {
    setEvict(false);
    const s = session(3);
    s.host.appendEntry(PIN_ENTRY_TYPE, { v: 1, op: "add", id: 1, text: "a note", by: "user", at: 1 });
    expect(sent(s).messages).toBeUndefined();
  });
});

describe("/keel-evict", () => {
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
    const h = fakeHost({ appendEntry: s.host.appendEntry });
    const result = h.fire("context", { messages: s.request() }, { ...s.ctx(), ui: { notify: () => {} } });
    expect(texts(result.messages)[0]).toStartWith("[#0–#7 out of context: 2 turns, by the user.");
  });

  it("leaves the request alone without reading the session for it, with the setting off and nothing recorded", async () => {
    setEvict(false);
    const s = session(4);
    const h = fakeHost({ appendEntry: s.host.appendEntry });
    // The eviction's context handler, registered last (omp's raw capture reads the session on its own).
    const handler = (event: any, ctx: any) => h.handlers.get("context")!.at(-1)!({ type: "context", ...event }, ctx);
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
  it("takes out the oldest finished turns, by keel, and says so", () => {
    setEvict(true);
    const s = session(10, 30_000, 80_000);
    const { messages, notice } = sent(s, 100_000);
    expect(s.appended).toHaveLength(1);
    expect(s.appended[0].data).toMatchObject({ op: "evict", from: 0, by: "auto" });
    const to = s.appended[0].data.to;
    expect(notice).toContain(`#0–#${to} out · by keel as the context filled`);
    const shown = texts(messages);
    expect(shown[0]).toContain("by keel as the context filled");
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
    expect(first.note).toMatch(/^\[keel: the context is past \d0% of where the host compacts \(~83616 tokens\); past 85% the oldest turns leave by themselves\. keel_context lists what is in it and takes old turns out, with a note of what to keep\.\]$/);
    expect(s.appended.map((e) => e.data.op)).toEqual(["budget"]);
    // The same tenth again: nothing more is said.
    expect(sent(s, 100_000, true).note).toBeUndefined();
    // Without keel_context the note would name a tool that is not there; below half nothing is said.
    expect(sent(session(10, 20_000, 50_000), 100_000, false).note).toBeUndefined();
    expect(sent(session(10, 1_000, 20_000), 100_000, true).note).toBeUndefined();
  });

  it("tells again from half once the agent or the user shrank the context, not after keel's own eviction", () => {
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
    // One turn: its request and its newest step stay, so keel_context could take nothing.
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
