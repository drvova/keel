// Old turns out of the context whole (lisp/src/evict.lisp): taken out by the
// agent (vcc_context), the user (/omp-vcc-evict) or omp-vcc past 85% of the
// trigger, left out of every later request with one line in their place, and
// brought back; the session file keeps them, and vcc_recall reads them back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { evict, evictRequest, type EvictCall } from "../src/core/evict";
import { registerEviction } from "../src/hooks/eviction";
import { EVICT_ENTRY_TYPE, PIN_ENTRY_TYPE } from "../src/names";
import { ompBinding } from "./support/binding";
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
  return { entries, appended, host, ctx, request };
};

const call = (s: ReturnType<typeof session>, c: EvictCall) => evict(s.host, ompBinding, s.ctx() as any, c);
const tool = (s: ReturnType<typeof session>, params: unknown) => call(s, { surface: "tool", params });
const sent = (s: ReturnType<typeof session>, window?: number, tool = false) => evictRequest(s.host, ompBinding, s.ctx(window) as any, s.request(), tool);
const record = (s: ReturnType<typeof session>, op: Record<string, unknown>) => s.host.appendEntry(EVICT_ENTRY_TYPE, { v: 1, by: "agent", at: 99, ...op });
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

describe("pinned notes when turns leave", () => {
  it("travel with the turn they were pinned in: its line carries the ones still held, as they read now", () => {
    setEvict(true);
    const s = session(4);
    // Pinned in turn 0 (#0–#3) and turn 1; the one in turn 1 is defined again in turn 3.
    s.host.appendEntry(PIN_ENTRY_TYPE, { v: 1, op: "add", id: 1, text: "sessions live in SQLite", by: "agent", at: 1 });
    s.host.appendEntry(PIN_ENTRY_TYPE, { v: 1, op: "add", id: 2, name: "test-cmd", text: "bun test", by: "agent", at: 5 });
    s.host.appendEntry(PIN_ENTRY_TYPE, { v: 1, op: "add", id: 3, name: "test-cmd", text: "bun test --isolate", by: "agent", at: 13 });
    record(s, { op: "evict", from: 0, to: 7 });
    const line = texts(sent(s).messages)[0];
    expect(line).toContain("Pinned there, still held: [1] sessions live in SQLite (agent, #1).");
    expect(line).not.toContain("test-cmd");
    const listing = tool(s, null);
    expect(listing).toContain("Pinned (vcc_pin; a name pinned again replaces its note):\n  [1] sessions live in SQLite (agent, #1)\n  [3] test-cmd: bun test --isolate (agent, #13)");
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
    // The request itself is left as it is: the note is stored and sent before the next model call.
    expect(first.messages).toBeUndefined();
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
