// vcc_recall keeps the originals of what omp rewrites in the session file
// (src/core/raw-store.ts, src/hooks/raw-capture.ts), with no omp setting changed.
import { sessionLineage } from "../src/core/session-file";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendRawStore,
  keptContent,
  MAX_KEPT_CHARS,
  mayBeRewritten,
  rawStorePath,
  readRawStore,
  wasRewritten,
  withOriginalContent,
} from "../src/core/raw-store";
import { captureNewEntries, createRawCaptureState, pointPlaceholders, registerRawCapture } from "../src/hooks/raw-capture";
import { registerRecallTool } from "../src/tools/recall";
import { listProjectSessions } from "../src/core/sessions";

let dir: string;
const prev = process.env.OMP_VCC_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-raw-"));
  process.env.OMP_VCC_CONFIG_PATH = join(dir, "omp-vcc-config.json");
});
afterAll(() => {
  if (prev === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

const text = (t: string) => [{ type: "text", text: t }];

describe("what is kept", () => {
  it("tool output and long text, not short messages or what omp already rewrote", () => {
    expect(mayBeRewritten({ role: "toolResult", content: text("ok") })).toBe(true);
    expect(mayBeRewritten({ role: "toolResult", content: [] })).toBe(false);
    expect(mayBeRewritten({ role: "toolResult", content: text("x"), prunedAt: 1 })).toBe(false);
    expect(mayBeRewritten({ role: "assistant", content: text("short reply") })).toBe(false);
    expect(mayBeRewritten({ role: "assistant", content: text("y".repeat(1_500)) })).toBe(true);
    expect(mayBeRewritten({ role: "user", content: "z".repeat(1_500) })).toBe(true);
    expect(mayBeRewritten({ role: "bashExecution", command: "ls", output: "a".repeat(5_000) })).toBe(false);
  });

  it("keeps text (clipped) and drops image data", () => {
    const kept = keptContent([{ type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "QUJD".repeat(1000) }]) as any[];
    expect(kept).toEqual([{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }]);
    const huge = keptContent(text("b".repeat(MAX_KEPT_CHARS + 10))) as any[];
    expect(huge[0].text).toEndWith(`...[omp-vcc kept the first ${MAX_KEPT_CHARS} of ${MAX_KEPT_CHARS + 10} chars]`);
  });

  it("puts back what omp rewrote: a tool result whole, another message block by block", () => {
    expect(wasRewritten({ role: "toolResult", content: text("[Output truncated - 900 tokens]"), prunedAt: 5 })).toBe(true);
    expect(wasRewritten({ role: "assistant", content: text("see [… moved to artifact://3]") })).toBe(true);
    expect(wasRewritten({ role: "assistant", content: text("plain") })).toBe(false);
    expect(withOriginalContent({ role: "toolResult", content: text("[Output truncated]"), prunedAt: 5, toolCallId: "c" } as any, text("full output")))
      .toEqual({ role: "toolResult", content: text("full output"), toolCallId: "c" });
    const call = { type: "toolCall", id: "t", name: "read", arguments: { path: "a.ts" } };
    expect(withOriginalContent({ role: "assistant", content: [{ type: "text", text: "[artifact://3]" }, call] }, [{ type: "text", text: "the block" }, call]))
      .toEqual({ role: "assistant", content: [{ type: "text", text: "the block" }, call] });
  });
});

describe("with omp's own session manager", () => {
  const recallOn = async (sm: any, params: Record<string, unknown>) => {
    let tool: any;
    registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
    const result = await tool.execute("call", params, undefined, undefined, { sessionManager: sm });
    return result.content[0].text as string;
  };

  it("recall reads what omp blanked or shook, from the copy taken as the messages landed", async () => {
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ keepOriginals: true }));
    const omp: any = await import("@oh-my-pi/pi-coding-agent");
    const sessions = join(dir, "sessions");
    const sm = omp.SessionManager.create(dir, sessions);
    const now = Date.now();
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const assistant = (content: unknown[]) => sm.appendMessage({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "m", stopReason: "toolUse", usage, timestamp: now });
    const state = createRawCaptureState();

    sm.appendMessage({ role: "user", content: "find why the zebrafish job fails", timestamp: now });
    assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat job.log" } }]);
    sm.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: text(`${"noise\n".repeat(300)}ERROR zebrafish quota exceeded at step 7\n`), isError: false, timestamp: now });
    assistant([{ type: "text", text: `Here is the config:\n\`\`\`yaml\n${"key: value\n".repeat(150)}retries: 11\n\`\`\`` }]);
    expect(captureNewEntries(state, sm)).toBe(2);
    expect(captureNewEntries(state, sm)).toBe(0);

    // What omp does: blank the tool output (pruning) and shake the block into an
    // artifact, then persist the rewrite.
    const entries = sm.getEntries();
    const result = entries.find((e: any) => e.message?.role === "toolResult").message;
    result.content = text("[Output truncated - 1200 tokens]");
    result.prunedAt = Date.now();
    const reply = entries.filter((e: any) => e.message?.role === "assistant").at(-1).message;
    reply.content = text("Here is the config:\n[yaml block moved to artifact://1]");
    await sm.rewriteEntries();
    // A later turn, so these are history recall searches, not the turn in progress.
    sm.appendMessage({ role: "user", content: "thanks, now the docs", timestamp: now });
    const file = sm.getSessionFile();
    expect(readFileSync(file, "utf8")).not.toContain("zebrafish quota");
    expect(readFileSync(file, "utf8")).not.toContain("retries: 11");

    const found = await recallOn(sm, { query: "zebrafish quota exceeded" });
    expect(found).toContain("ERROR zebrafish quota exceeded at step 7");
    expect(await recallOn(sm, { query: "retries 11" })).toContain("retries: 11");
    const resultIndex = entries.findIndex((e: any) => e.message?.role === "toolResult");
    expect(await recallOn(sm, { expand: [resultIndex] })).toContain("ERROR zebrafish quota exceeded at step 7");

    // The copy is not a session to omp or to recall's project listing.
    expect(existsSync(rawStorePath(file))).toBe(true);
    expect(listProjectSessions(sessions, "").map((s) => s.file)).toEqual([file]);

    // Without it, the placeholder is all there is.
    rmSync(rawStorePath(file));
    expect(await recallOn(sm, { query: "zebrafish quota exceeded" })).not.toContain("step 7");
  });

  it("is taken on omp's events, and not when keepOriginals is off", () => {
    const handlers = new Map<string, Array<(e: unknown, c: unknown) => void>>();
    registerRawCapture({ on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]) } as any);
    expect([...handlers.keys()].sort()).toEqual(["agent_end", "context", "message_end", "session_start", "turn_end"]);
    const file = join(dir, "events.jsonl");
    const entries: any[] = [{ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c", content: text("out") } }];
    const ctx = { sessionManager: { getSessionFile: () => file, getEntries: () => entries } };
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ keepOriginals: false }));
    handlers.get("message_end")![0]({}, ctx);
    expect(existsSync(rawStorePath(file))).toBe(false);
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ keepOriginals: true }));
    handlers.get("turn_end")![0]({}, ctx);
    expect([...readRawStore(file, new Set(["r1"])).values()]).toEqual([text("out")]);
  });
});

describe("the summary is written from the originals", () => {
  it("a commit whose git output omp blanked before omp-vcc compacted is still in [Commits]", async () => {
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ overrideDefaultCompaction: true }));
    const { registerHook } = await import("./support/host");
    let handler: any;
    registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    const file = join(dir, "hook.jsonl");
    const msg = (id: string, message: Record<string, unknown>) => ({ type: "message", id, message });
    const entries = [
      msg("u1", { role: "user", content: "commit the rounding fix please" }),
      msg("a1", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: 'git commit -am "fix: rounding in totals"' } }] }),
      msg("r1", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: text("[Output truncated - 60 tokens]"), prunedAt: 1, isError: false }),
      msg("a2", { role: "assistant", content: text("Committed.") }),
      msg("u2", { role: "user", content: "now update the docs" }),
      msg("a3", { role: "assistant", content: text("Docs updated.") }),
    ];
    const summarize = () => handler({
      type: "session_before_compact", branchEntries: entries, customInstructions: "keep:1",
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} }, sessionManager: { getSessionFile: () => file, getEntries: () => entries, getBranch: () => entries } }).compaction.summary as string;

    expect(summarize()).not.toContain("4f2a9c1");
    appendRawStore(file, [{ id: "r1", content: text("[main 4f2a9c1] fix: rounding in totals\n 1 file changed, 2 insertions(+)") }]);
    const summary = summarize();
    expect(summary).toContain("[Commits]\n- 4f2a9c1: fix: rounding in totals");
    // The live entry is untouched: the context still holds omp's placeholder.
    expect((entries[2].message.content as any)[0].text).toBe("[Output truncated - 60 tokens]");
  });
});

describe("omp's placeholders point at the original", () => {
  const entries = [
    { type: "message", id: "u0", message: { role: "user", content: "look at the log" } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat app.log" } }] } },
    { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", content: text("[Output truncated - 1200 tokens]"), prunedAt: 1 } },
  ];
  const sm = { getEntries: () => entries, getBranch: () => entries };
  const placeholder = (t: string) => ({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: text(t) });
  const kept = (ids: string[]) => ({ ...createRawCaptureState(), kept: new Set(ids) });

  it("names the recall ref when omp-vcc kept the original, the same text every time", () => {
    for (const notice of ["[Output truncated - 1200 tokens]", "[Superseded by a newer read of this file]", "[Uneventful result elided]"]) {
      const messages = [{ role: "user", content: "look at the log" }, placeholder(notice)];
      const out = pointPlaceholders(messages, kept(["r1"]), sm) as any[];
      expect(out[1].content).toEqual(text(`${notice} (the original: vcc_recall expand:[2])`));
      expect(pointPlaceholders(messages, kept(["r1"]), sm)).toEqual(out);
      // The request's own messages are not changed in place.
      expect(messages[1].content).toEqual(text(notice));
    }
  });

  it("says nothing it cannot back: no original kept, or not omp's placeholder", () => {
    expect(pointPlaceholders([placeholder("[Output truncated - 1200 tokens]")], kept([]), sm)).toBeUndefined();
    expect(pointPlaceholders([placeholder("[Output truncated - 1200 tokens]")], kept(["other"]), sm)).toBeUndefined();
    expect(pointPlaceholders([placeholder("real output that happens to be short")], kept(["r1"]), sm)).toBeUndefined();
    expect(pointPlaceholders([{ ...placeholder("[Output truncated - 1200 tokens]"), toolCallId: "unknown" }], kept(["r1"]), sm)).toBeUndefined();
  });
});

describe("a fork reads its parent's originals", () => {
  it("what the parent kept before the fork, recall in the fork still finds", async () => {
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH!, JSON.stringify({ keepOriginals: true }));
    const omp: any = await import("@oh-my-pi/pi-coding-agent");
    const sessions = join(dir, "fork-sessions");
    const sm = omp.SessionManager.create(dir, sessions);
    const now = Date.now();
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    sm.appendMessage({ role: "user", content: "check the deploy log", timestamp: now });
    sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "d1", name: "bash", arguments: { command: "cat deploy.log" } }], api: "anthropic-messages", provider: "anthropic", model: "m", stopReason: "toolUse", usage, timestamp: now });
    sm.appendMessage({ role: "toolResult", toolCallId: "d1", toolName: "bash", content: text("deploy aborted: pelican-7 healthcheck timed out"), isError: false, timestamp: now });
    sm.appendMessage({ role: "assistant", content: text("The healthcheck timed out."), api: "anthropic-messages", provider: "anthropic", model: "m", stopReason: "stop", usage, timestamp: now });
    const state = createRawCaptureState();
    expect(captureNewEntries(state, sm)).toBe(1);
    const parentFile = sm.getSessionFile();

    const forked = await sm.fork();
    expect(forked?.newSessionFile).toBe(sm.getSessionFile());
    // In the fork, omp blanks the result and persists it; the fork has no store of its own.
    const result = sm.getEntries().find((e: any) => e.message?.role === "toolResult").message;
    result.content = text("[Output truncated - 40 tokens]");
    result.prunedAt = Date.now();
    sm.appendMessage({ role: "user", content: "try again with a longer timeout", timestamp: now });
    await sm.rewriteEntries();
    expect(sm.getSessionFile()).not.toBe(parentFile);
    expect(existsSync(rawStorePath(sm.getSessionFile()))).toBe(false);
    expect(sessionLineage(sm.getSessionFile())).toEqual([sm.getSessionFile(), parentFile]);
    // Its capture knows the parent's copy, so nothing is copied twice.
    expect(captureNewEntries(state, sm)).toBe(0);

    let tool: any;
    registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
    const found = (await tool.execute("f", { query: "pelican healthcheck" }, undefined, undefined, { sessionManager: sm })).content[0].text;
    expect(found).toContain("deploy aborted: pelican-7 healthcheck timed out");
  });
});
