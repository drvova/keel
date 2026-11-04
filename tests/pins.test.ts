import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nextPinId, PIN_CHARS, PIN_ENTRY_TYPE, readPins } from "../src/core/pins";
import { addPin, executePin, removePin } from "../src/tools/pin";
import { registerPinCommands } from "../src/commands/pin";
import { registerHook } from "./support/host";
import { runLongHorizon } from "./support/long-horizon";

/** A session whose branch is an array; appendEntry adds to it, as the hosts do. */
const session = (initial: any[] = []) => {
  const entries = [...initial];
  let n = 0;
  return {
    entries,
    host: { appendEntry: (customType: string, data?: unknown) => { entries.push({ type: "custom", id: `c${++n}`, customType, data }); } },
    sm: { getBranch: () => entries, getEntries: () => entries },
  };
};

const message = (id: string, role = "user", text = "hello there") =>
  ({ type: "message", id, message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] } });

describe("pinned notes: storage", () => {
  it("replays pins and unpins along the branch, recording the #N they were made at", () => {
    const s = session([message("m1"), message("m2", "assistant")]);
    expect(addPin(s.host, s.sm, "never edit migrations/", "user")).toBe("Pinned [1] never edit migrations/ (user, #1).");
    expect(addPin(s.host, s.sm, "  sessions   in SQLite ", "agent")).toBe("Pinned [2] sessions in SQLite (agent, #1).");
    expect(readPins(s.entries).map((n) => [n.id, n.text, n.by])).toEqual([[1, "never edit migrations/", "user"], [2, "sessions in SQLite", "agent"]]);
    expect(removePin(s.host, s.sm, "#1")).toBe("Unpinned [1] never edit migrations/ (user, #1).");
    expect(readPins(s.entries).map((n) => n.id)).toEqual([2]);
    // An id is never reused, so an old [1] cannot come to mean a new note.
    expect(nextPinId(s.entries)).toBe(3);
  });

  it("refuses an empty note and a duplicate, clips a long one", () => {
    const s = session();
    expect(addPin(s.host, s.sm, "   ", "user")).toBe("Nothing to pin: give the note text.");
    addPin(s.host, s.sm, "keep the API stable", "user");
    expect(addPin(s.host, s.sm, "keep the API stable", "agent")).toBe("Already pinned: [1] keep the API stable (user).");
    expect(addPin(s.host, s.sm, "x".repeat(PIN_CHARS + 50), "agent")).toContain(`(clipped to ${PIN_CHARS} chars)`);
  });

  it("ignores other extensions' entries and malformed data, and hides pins made before omp's /clear", () => {
    const entries = [
      { type: "custom", customType: "someone-else", data: { op: "add", id: 1, text: "not ours" } },
      { type: "custom", customType: PIN_ENTRY_TYPE, data: { op: "add", id: "x", text: "bad id" } },
      { type: "custom", customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 1, text: "before clear", by: "user" } },
      { type: "reset_boundary", id: "r" },
      { type: "custom", customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 2, text: "after clear", by: "agent" } },
    ];
    expect(readPins(entries).map((n) => n.text)).toEqual(["after clear"]);
  });
});

describe("vcc_pin", () => {
  it("note pins, unpin removes, neither lists, both is refused", () => {
    const s = session();
    expect(executePin({}, s.host, s.sm)).toBe("No pinned notes.");
    expect(executePin({ note: "deploy host has no Redis" }, s.host, s.sm)).toContain("Pinned [1]");
    expect(executePin({}, s.host, s.sm)).toBe("Pinned notes (kept at the top of every summary):\n- [1] deploy host has no Redis (agent)");
    expect(executePin({ note: "x", unpin: 1 }, s.host, s.sm)).toBe("Send note or unpin, not both, in one call.");
    expect(executePin({ unpin: "[1]" }, s.host, s.sm)).toContain("Unpinned [1]");
    expect(executePin({ unpin: 7 }, s.host, s.sm)).toBe("No pinned note [7]. No pinned notes.");
  });
});

describe("/omp-vcc-pin and /omp-vcc-unpin", () => {
  it("pin, tell the agent on its next turn, list, unpin", async () => {
    const s = session([message("m1")]);
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const sent: any[] = [];
    const notices: string[] = [];
    registerPinCommands({
      registerCommand: (name: string, c: any) => commands.set(name, c.handler),
      appendEntry: s.host.appendEntry,
      sendMessage: (m: any, o: any) => sent.push({ m, o }),
    } as any);
    const ctx = { sessionManager: s.sm, ui: { notify: (m: string) => notices.push(m) } };
    await commands.get("omp-vcc-pin")!("never edit migrations/", ctx);
    expect(notices.at(-1)).toBe("Pinned [1] never edit migrations/ (user, #0).");
    expect(sent[0]).toEqual({
      m: { customType: "omp-vcc-pin", content: "The user pinned [1] never edit migrations/ (user, #0). It stays at the top of every summary.", display: true },
      o: { deliverAs: "nextTurn" },
    });
    await commands.get("omp-vcc-pin")!("", ctx);
    expect(notices.at(-1)).toContain("- [1] never edit migrations/");
    await commands.get("omp-vcc-unpin")!("1", ctx);
    expect(readPins(s.entries)).toEqual([]);
    expect(sent.at(-1).m.content).toContain("The user unpinned [1]");
  });
});

describe("pinned notes in summaries", () => {
  let dir: string;
  const prev = process.env.OMP_VCC_CONFIG_PATH;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-vcc-pins-"));
    process.env.OMP_VCC_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.OMP_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false }));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
    else process.env.OMP_VCC_CONFIG_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("come first in the summary, verbatim", () => {
    const s = session([message("m1", "user", "first request here"), message("m2", "assistant", "ok"), message("m3", "user", "second request here"), message("m4", "assistant", "ok")]);
    addPin(s.host, s.sm, "never edit migrations/", "user");
    let handler: any;
    const hook = registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    hook.autoCompactionStart("threshold");
    const out = handler({
      type: "session_before_compact", branchEntries: s.entries, customInstructions: undefined,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 100 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} }, sessionManager: s.sm });
    expect(out.compaction.summary.startsWith("[Pinned Notes]\n- [1] never edit migrations/ (user, #3)\n\n[Early Session Requests]")).toBe(true);
  });

  it("the notice /omp-vcc-pin sends the agent is not repeated in the transcript", () => {
    const notice = { type: "custom_message", id: "n1", customType: "omp-vcc-pin", content: "The user pinned [1] never edit migrations/ (user, #3). It stays at the top of every summary.", display: true, timestamp: "2026-01-01T00:00:00.000Z" };
    const s = session([message("m1", "user", "first request here"), message("m2", "assistant", "ok"), notice, message("m3", "user", "second request here"), message("m4", "assistant", "ok")]);
    addPin(s.host, s.sm, "never edit migrations/", "user");
    let handler: any;
    registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    const out = handler({
      type: "session_before_compact", branchEntries: s.entries, customInstructions: "__omp_vcc__ keep:1",
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 100 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} }, sessionManager: s.sm });
    expect(out.compaction.summary).toContain("[Pinned Notes]\n- [1] never edit migrations/");
    expect(out.compaction.summary).not.toContain("The user pinned");
  });

  it("survive 20 compactions of a long session unchanged", async () => {
    const pin = "Sessions are stored in SQLite rather than Redis: the deploy host has no Redis.";
    const r = await runLongHorizon({ turns: 120, compactEvery: 6, pins: { 9: pin } });
    expect(r.compactions).toBe(20);
    expect(r.finalSummary.startsWith(`[Pinned Notes]\n- [1] ${pin} (agent`)).toBe(true);
  }, 120_000);
});
