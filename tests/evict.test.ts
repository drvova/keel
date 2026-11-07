// Old turns out of the context whole (lisp/src/evict.lisp): taken out by the
// agent (vcc_context), the user (/omp-vcc-evict) or omp-vcc past 85% of the
// trigger, left out of every later request with one line in their place, and
// brought back; the session file keeps them, and vcc_recall reads them back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { evict, evictRequest, type EvictCall } from "../src/core/evict";
import { EVICT_ENTRY_TYPE } from "../src/names";
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

/** A session of TURNS turns, each a request, a read and its result of SIZE chars; the last assistant reports PROMPT tokens. */
const session = (turns: number, size = 200, prompt?: number) => {
  const entries: any[] = [];
  let t = 1_700_000_000_000;
  const add = (message: any) => {
    const id = `e${entries.length}`;
    entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, message: { ...message, timestamp: t++ } });
  };
  for (let i = 0; i < turns; i++) {
    add({ role: "user", content: `request number ${i} please read f${i}.ts` });
    add({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i}.ts` } }] });
    add({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: `${i}:`.padEnd(size, "x") }] });
  }
  if (prompt !== undefined) entries.at(-2).message.usage = { input: prompt, output: 10, cacheRead: 0, cacheWrite: 0 };
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
const sent = (s: ReturnType<typeof session>, window?: number) => evictRequest(s.host, ompBinding, s.ctx(window) as any, s.request());
const texts = (messages: unknown[] | undefined) => (messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : m.content[0]?.text ?? m.content[0]?.type));

describe("vcc_context", () => {
  it("lists the turns in context by #N, the running one last", () => {
    setEvict(true);
    const s = session(3);
    const text = tool(s, null);
    expect(text).toContain("In context: 3 turns");
    expect(text).toContain('#0–#2 ~');
    expect(text).toContain('"request number 0 please read f0.ts"');
    expect(text).toContain("#6–#8 ~");
    expect(text).toContain("Nothing is out of context.");
    expect(s.appended).toEqual([]);
  });

  it("takes whole turns out from the next request, a line naming them in their place", () => {
    setEvict(true);
    const s = session(4);
    expect(tool(s, { drop: ["#1-#4"], note: "f0 and f1 were read; nothing to fix there" })).toContain("Out of context from the next request: #0–#5 (2 turns");
    expect(s.appended.map((e) => [e.customType, e.data.op, e.data.from, e.data.to, e.data.by])).toEqual([[EVICT_ENTRY_TYPE, "evict", 0, 5, "agent"]]);
    const { messages } = sent(s);
    const shown = texts(messages);
    // The two turns' six messages are gone; one line stands where they were, then turns 2 and 3 as they are.
    expect(shown).toHaveLength(1 + 6);
    expect(shown[0]).toBe('[#0–#5 out of context: 2 turns, ~' + shown[0].match(/~(\d+) tokens/)![1] + ' tokens, by the agent. Requests: "request number 0 please read f0.ts"; "request number 1 please read f1.ts". Note: f0 and f1 were read; nothing to fix there. Each entry reads back word for word with vcc_recall expand:[0]; vcc_recall query searches them.]');
    expect(shown[1]).toBe("request number 2 please read f2.ts");
    // A call and its result leave together: what stays has every result's call.
    const calls = new Set((messages as any[]).flatMap((m) => (m.role === "assistant" ? m.content.map((p: any) => p.id) : [])));
    expect((messages as any[]).filter((m) => m.role === "toolResult").every((m) => calls.has(m.toolCallId))).toBe(true);
    // The same line on every request, so the provider's cache keeps it.
    expect(texts(sent(s).messages)[0]).toBe(shown[0]);
  });

  it("never takes out the turn running now", () => {
    setEvict(true);
    const s = session(2);
    expect(tool(s, { drop: "#3-#5" })).toContain("Nothing to take out");
    expect(s.appended).toEqual([]);
  });

  it("takes out the oldest turns by count, and brings turns back", () => {
    setEvict(true);
    const s = session(5);
    expect(tool(s, { oldest: 2 })).toContain("#0–#5 (2 turns");
    expect(tool(s, { oldest: 1 })).toContain("#6–#8 (1 turn");
    expect(tool(s, null)).toContain("Out of context:\n  #0–#8 (3 turns)");
    expect(tool(s, { restore: "#0" })).toBe("Back in context from the next request: #0–#5.");
    expect(texts(sent(s).messages)[0]).toBe("request number 0 please read f0.ts");
    expect(texts(sent(s).messages)).toContain(texts(sent(s).messages).find((t) => t.startsWith("[#6–#8 out of context: 1 turn")));
  });
});

describe("/omp-vcc-evict", () => {
  const command = (s: ReturnType<typeof session>, args: string) => call(s, { surface: "command", args });

  it("takes out the oldest half with no text, a number of turns, all, or a range; and restores", () => {
    setEvict(false);
    const s = session(5);
    expect(command(s, "")).toContain("#0–#5 (2 turns");
    expect(command(s, "1")).toContain("#6–#8 (1 turn");
    expect(command(s, "restore all")).toBe("Back in context from the next request: #0–#5, #6–#8.");
    expect(command(s, "all")).toContain("#0–#11 (4 turns");
    expect(command(s, "list")).toContain("In context: 1 turn");
    expect(command(s, "restore #3")).toBe("Back in context from the next request: #0–#11.");
    expect(command(s, "#3-#4")).toContain("#3–#5 (1 turn");
    expect(command(s, "whatever")).toContain("Not understood: whatever.");
    expect(s.appended.map((e) => e.data.by).every((b) => b === "user")).toBe(true);
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
