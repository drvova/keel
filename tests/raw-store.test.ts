// keel_recall keeps the originals of what omp rewrites in the session file
// (<session>.jsonl.keel-raw: src/raw-capture.ts, lisp/src/raw-capture.lisp and
// session.lisp), with no omp setting changed. Putting an original back is held
// to its rules in lisp/test/store.lisp.
import { ompBinding, recallTool } from "./support/binding";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

/** The store beside a session file. */
const rawStorePath = (file: string): string => `${file}${RAW_STORE_SUFFIX}`;
/** What the store keeps, by id: the first copy of each (the store's format: one {id, content} line each). */
const readRawStore = (file: string, ids: Set<string>): Map<string, unknown> => {
  const kept = new Map<string, unknown>();
  if (!existsSync(rawStorePath(file))) return kept;
  for (const line of readFileSync(rawStorePath(file), "utf8").split("\n")) {
    try {
      const r = JSON.parse(line);
      if (ids.has(r.id) && !kept.has(r.id)) kept.set(r.id, r.content);
    } catch {}
  }
  return kept;
};
import { captureNewEntries, createRawCaptureState, pointPlaceholders, registerRawCapture } from "../src/raw-capture";
import { MAX_KEPT_CHARS, RAW_STORE_SUFFIX } from "./support/names";
import { tempConfig } from "./support/config";

const config = tempConfig("keel-raw-");

const text = (t: string) => [{ type: "text", text: t }];

describe("what is kept", () => {
  /** What one capture of these messages keeps in the store, by id. */
  const keptOf = (name: string, messages: unknown[]): Map<string, unknown> => {
    const file = join(config.dir, `${name}.jsonl`);
    const entries = messages.map((message, i) => ({ type: "message", id: `k${i}`, message }));
    captureNewEntries(createRawCaptureState(), { getSessionFile: () => file, getEntries: () => entries });
    return readRawStore(file, new Set(entries.map((e) => e.id)));
  };

  it("tool output and long text, not short messages or what omp already rewrote", () => {
    const kept = keptOf("which", [
      { role: "toolResult", content: text("ok") },
      { role: "toolResult", content: [] },
      { role: "toolResult", content: text("x"), prunedAt: 1 },
      { role: "assistant", content: text("short reply") },
      { role: "assistant", content: text("y".repeat(1_500)) },
      { role: "user", content: "z".repeat(1_500) },
      { role: "bashExecution", command: "ls", output: "a".repeat(5_000) },
    ]);
    expect([...kept.keys()].sort()).toEqual(["k0", "k4", "k5"]);
  });

  it("keeps text (clipped) and drops image data", () => {
    const kept = keptOf("what", [
      { role: "toolResult", content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "QUJD".repeat(1000) }] },
      { role: "toolResult", content: text("b".repeat(MAX_KEPT_CHARS + 10)) },
    ]);
    expect(kept.get("k0")).toEqual([{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }]);
    expect((kept.get("k1") as any[])[0].text).toEndWith(`...[keel kept the first ${MAX_KEPT_CHARS} of ${MAX_KEPT_CHARS + 10} chars]`);
  });
});

describe("with omp's own session manager", () => {
  const recallOn = async (sm: any, params: Record<string, unknown>) => {
    const tool = recallTool();
    const result = await tool.execute("call", params, undefined, undefined, { sessionManager: sm });
    return result.content[0].text as string;
  };

  it("recall reads what omp blanked or shook, from the copy taken as the messages landed", async () => {
    writeFileSync(config.path, JSON.stringify({ keepOriginals: true }));
    const omp: any = await import("@oh-my-pi/pi-coding-agent");
    const sessions = join(config.dir, "sessions");
    const sm = omp.SessionManager.create(config.dir, sessions);
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
    expect(await recallOn(sm, { mode: "sessions" })).toStartWith("No earlier sessions in this project");

    // A store keel kept as omp-vcc (.vcc-raw) is read the same.
    renameSync(rawStorePath(file), `${file}.vcc-raw`);
    expect(await recallOn(sm, { query: "zebrafish quota exceeded" })).toContain("step 7");
    renameSync(`${file}.vcc-raw`, rawStorePath(file));

    // Without it, the placeholder is all there is.
    rmSync(rawStorePath(file));
    expect(await recallOn(sm, { query: "zebrafish quota exceeded" })).not.toContain("step 7");
  });

  it("is taken on omp's events, and not when keepOriginals is off", () => {
    const handlers = new Map<string, Array<(e: unknown, c: unknown) => void>>();
    registerRawCapture({ on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]) } as any, ompBinding);
    const file = join(config.dir, "events.jsonl");
    const entries: any[] = [{ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c", content: text("out") } }];
    const ctx = { sessionManager: { getSessionFile: () => file, getEntries: () => entries } };
    const fireAll = () => { for (const hs of handlers.values()) for (const h of hs) h({ messages: [] }, ctx); };
    writeFileSync(config.path, JSON.stringify({ keepOriginals: false }));
    fireAll();
    expect(existsSync(rawStorePath(file))).toBe(false);
    // Off, the events passed the message by without taking it as seen.
    writeFileSync(config.path, JSON.stringify({ keepOriginals: true }));
    handlers.get("message_end")![0]({}, ctx);
    expect([...readRawStore(file, new Set(["r1"])).values()]).toEqual([text("out")]);
  });
});

describe("the summary is written from the originals", () => {
  it("a write that fails is tried again on the next event, not given up", () => {
    const file = join(config.dir, "retry.jsonl");
    const entries = [{ type: "message", id: "t1", message: { role: "toolResult", toolCallId: "c", content: text("out") } }];
    const sm = { getSessionFile: () => file, getEntries: () => entries };
    const state = createRawCaptureState();
    // The store's path is a directory: appending to it fails, as on a full disk.
    mkdirSync(rawStorePath(file), { recursive: true });
    expect(captureNewEntries(state, sm)).toBe(0);
    rmSync(rawStorePath(file), { recursive: true, force: true });
    expect(captureNewEntries(state, sm)).toBe(1);
    expect([...readRawStore(file, new Set(["t1"])).values()]).toEqual([text("out")]);
  });

  it("a switch to another session and back copies nothing twice", () => {
    const a = join(config.dir, "switch-a.jsonl");
    const b = join(config.dir, "switch-b.jsonl");
    const entries = (p: string) => [{ type: "message", id: `${p}1`, message: { role: "toolResult", toolCallId: "c", content: text(`${p} out`) } }];
    const state = createRawCaptureState();
    let file = a;
    const sm = { getSessionFile: () => file, getEntries: () => entries(file === a ? "a" : "b") };
    expect(captureNewEntries(state, sm)).toBe(1);
    file = b;
    expect(captureNewEntries(state, sm)).toBe(1);
    file = a;
    // Back in the first session, its store already keeps what it holds.
    expect(captureNewEntries(state, sm)).toBe(0);
    expect(readFileSync(rawStorePath(a), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("a fork's capture skips what its parent's store keeps already, and copies what it does not", () => {
    const parent = join(config.dir, "parent.jsonl");
    const child = join(config.dir, "child.jsonl");
    writeFileSync(parent, `${JSON.stringify({ type: "session", id: "p" })}\n`);
    writeFileSync(child, `${JSON.stringify({ type: "session", id: "c", parentSession: parent })}\n`);
    writeFileSync(rawStorePath(parent), `${JSON.stringify({ id: "f1", content: text("the parent's copy") })}\n`);
    const entries = ["f1", "f2"].map((id) => ({ type: "message", id, message: { role: "toolResult", toolCallId: id, content: text(`${id} out`) } }));
    expect(captureNewEntries(createRawCaptureState(), { getSessionFile: () => child, getEntries: () => entries })).toBe(1);
    expect(readFileSync(rawStorePath(child), "utf8")).toBe(`${JSON.stringify({ id: "f2", content: text("f2 out") })}\n`);
  });

  it("a commit whose git output omp blanked before keel compacted is still in [Commits]", async () => {
    writeFileSync(config.path, JSON.stringify({ overrideDefaultCompaction: true }));
    const { registerHook } = await import("./support/host");
    let handler: any;
    registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    const file = join(config.dir, "hook.jsonl");
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
    writeFileSync(rawStorePath(file), `${JSON.stringify({ id: "r1", content: text("[main 4f2a9c1] fix: rounding in totals\n 1 file changed, 2 insertions(+)") })}\n`);
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

  it("names the recall ref when keel kept the original, the same text every time", () => {
    for (const notice of ["[Output truncated - 1200 tokens]", "[Superseded by a newer read of this file]", "[Uneventful result elided]"]) {
      const messages = [{ role: "user", content: "look at the log" }, placeholder(notice)];
      const out = pointPlaceholders(messages, kept(["r1"]), ompBinding, { sessionManager: sm }) as any[];
      expect(out[1].content).toEqual(text(`${notice} (the original: keel_recall expand:[2])`));
      expect(pointPlaceholders(messages, kept(["r1"]), ompBinding, { sessionManager: sm })).toEqual(out);
      // The request's own messages are not changed in place.
      expect(messages[1].content).toEqual(text(notice));
    }
  });

  it("says nothing it cannot back: no original kept, or not omp's placeholder", () => {
    expect(pointPlaceholders([placeholder("[Output truncated - 1200 tokens]")], kept([]), ompBinding, { sessionManager: sm })).toBeUndefined();
    expect(pointPlaceholders([placeholder("[Output truncated - 1200 tokens]")], kept(["other"]), ompBinding, { sessionManager: sm })).toBeUndefined();
    expect(pointPlaceholders([placeholder("real output that happens to be short")], kept(["r1"]), ompBinding, { sessionManager: sm })).toBeUndefined();
    expect(pointPlaceholders([{ ...placeholder("[Output truncated - 1200 tokens]"), toolCallId: "unknown" }], kept(["r1"]), ompBinding, { sessionManager: sm })).toBeUndefined();
  });
});

describe("a fork reads its parent's originals", () => {
  it("what the parent kept before the fork, recall in the fork still finds", async () => {
    writeFileSync(config.path, JSON.stringify({ keepOriginals: true }));
    const omp: any = await import("@oh-my-pi/pi-coding-agent");
    const sessions = join(config.dir, "fork-sessions");
    const sm = omp.SessionManager.create(config.dir, sessions);
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
    // Its capture knows the parent's copy, so nothing is copied twice.
    expect(captureNewEntries(state, sm)).toBe(0);

    const tool = recallTool();
    const found = (await tool.execute("f", { query: "pelican healthcheck" }, undefined, undefined, { sessionManager: sm })).content[0].text;
    expect(found).toContain("deploy aborted: pelican-7 healthcheck timed out");
  });
});
