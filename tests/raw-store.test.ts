// vcc_recall keeps the originals of what omp rewrites in the session file
// (src/core/raw-store.ts, src/hooks/raw-capture.ts), with no omp setting changed.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  keptContent,
  MAX_KEPT_CHARS,
  mayBeRewritten,
  rawStorePath,
  readRawStore,
  wasRewritten,
  withOriginalContent,
} from "../src/core/raw-store";
import { captureNewEntries, createRawCaptureState, registerRawCapture } from "../src/hooks/raw-capture";
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
    expect([...handlers.keys()].sort()).toEqual(["agent_end", "message_end", "session_start", "turn_end"]);
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
