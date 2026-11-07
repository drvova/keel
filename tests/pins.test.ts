import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PIN_CHARS } from "../src/names";
import { PIN_ENTRY_TYPE } from "../src/names";
import { executePin, ompBinding } from "./support/binding";
import { registerPinCommands } from "../src/commands/pin";
import { registerHook } from "./support/host";
import { carryPins } from "../src/core/pins";
import { writeJsonl, freshDir } from "./support/session-files";
import { utimesSync } from "fs";

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

/** The notes pinned on the session's branch, as keel_pin lists them: [id, text, by]. */
const readPins = (entries: any[]): Array<[number, string, string]> => {
  const s = { appendEntry: () => {} };
  const listed = executePin({}, s, { getBranch: () => entries, getEntries: () => entries });
  return [...listed.matchAll(/^- \[(\d+)\] (.*) \((user|agent)(?:, [^)]*)?\)$/gm)].map((m) => [Number(m[1]), m[2], m[3]]);
};

const message = (id: string, role = "user", text = "hello there") =>
  ({ type: "message", id, message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] } });

describe("pinned notes: storage", () => {
  // A note pinned by the agent's tool (by "agent"), or by the user's command (by "user").
  const pin = (s: ReturnType<typeof session>, note: string) => executePin({ note }, s.host, s.sm);
  const unpin = (s: ReturnType<typeof session>, id: unknown) => executePin({ unpin: id }, s.host, s.sm);

  it("replays pins and unpins along the branch, recording the #N they were made at", () => {
    const s = session([message("m1"), message("m2", "assistant")]);
    expect(pin(s, "never edit migrations/")).toBe("Pinned [1] never edit migrations/ (agent, #1).");
    expect(pin(s, "  sessions   in SQLite ")).toBe("Pinned [2] sessions in SQLite (agent, #1).");
    expect(readPins(s.entries)).toEqual([[1, "never edit migrations/", "agent"], [2, "sessions in SQLite", "agent"]]);
    expect(unpin(s, "#1")).toBe("Unpinned [1] never edit migrations/ (agent, #1).");
    expect(readPins(s.entries).map(([id]) => id)).toEqual([2]);
    // An id is never reused, so an old [1] cannot come to mean a new note.
    expect(pin(s, "a third note")).toBe("Pinned [3] a third note (agent, #1).");
  });

  it("lists on a blank note, refuses a duplicate, clips a long one", () => {
    const s = session();
    // A blank note is a note not given: the call lists the notes.
    expect(pin(s, "   ")).toBe("No pinned notes.");
    pin(s, "keep the API stable");
    expect(pin(s, "keep the API stable")).toBe("Already pinned: [1] keep the API stable (agent).");
    expect(pin(s, "x".repeat(PIN_CHARS + 50))).toContain(`(clipped to ${PIN_CHARS} chars)`);
  });

  it("ignores other extensions' entries and malformed data, and hides pins made before omp's /clear", () => {
    const entries = [
      { type: "custom", customType: "someone-else", data: { op: "add", id: 1, text: "not ours" } },
      { type: "custom", id: "p1", customType: PIN_ENTRY_TYPE, data: { op: "add", id: "x", text: "bad id" } },
      { type: "custom", id: "p2", customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 1, text: "before clear", by: "user" } },
      { type: "reset_boundary", id: "r" },
      { type: "custom", id: "p3", customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 2, text: "after clear", by: "agent" } },
    ];
    expect(readPins(entries).map(([, text]) => text)).toEqual(["after clear"]);
  });

  it("reads the pins keel wrote as omp-vcc, and a new pin goes on from their ids", () => {
    const s = session([
      message("m1"),
      { type: "custom", id: "p1", customType: "omp-vcc.pin", data: { v: 1, op: "add", id: 1, text: "pinned before the rename", by: "user" } },
    ]);
    expect(readPins(s.entries)).toEqual([[1, "pinned before the rename", "user"]]);
    expect(executePin({ note: "pinned after" }, s.host, s.sm)).toStartWith("Pinned [2] pinned after");
    expect(s.entries.at(-1).customType).toBe(PIN_ENTRY_TYPE);
  });
});

describe("keel_pin", () => {
  it("note pins, unpin removes, neither lists, both is refused", () => {
    const s = session();
    expect(executePin({}, s.host, s.sm)).toBe("No pinned notes.");
    expect(executePin({ note: "deploy host has no Redis" }, s.host, s.sm)).toContain("Pinned [1]");
    expect(executePin({}, s.host, s.sm)).toBe("Pinned notes (kept at the top of every summary):\n- [1] deploy host has no Redis (agent)");
    expect(executePin({ note: "x", unpin: 1 }, s.host, s.sm)).toBe("Send note or unpin, not both, in one call.");
    expect(executePin({ unpin: "[1]" }, s.host, s.sm)).toContain("Unpinned [1]");
    expect(executePin({ unpin: 7 }, s.host, s.sm)).toBe("No pinned note [7]. No pinned notes.");
  });

  it("a param sent empty is not sent, as the brief reads the call", () => {
    const s = session();
    expect(executePin({ note: "Sessions live in SQLite", unpin: "" }, s.host, s.sm)).toContain("Pinned [1]");
    expect(executePin({ note: "", unpin: null }, s.host, s.sm)).toContain("- [1] Sessions live in SQLite");
  });
});

describe("named notes", () => {
  it("a name pinned again replaces its note; unpin takes the name; a bad name is refused", () => {
    const s = session([message("m1"), message("m2", "assistant")]);
    expect(executePin({ note: "refresh after reset", name: "Auth-Plan" }, s.host, s.sm)).toBe("Pinned [1] auth-plan: refresh after reset (agent, #1).");
    expect(executePin({ note: "an unnamed note" }, s.host, s.sm)).toBe("Pinned [2] an unnamed note (agent, #1).");
    expect(executePin({ note: "refresh after reset", name: "auth-plan" }, s.host, s.sm)).toBe("Already pinned: [1] auth-plan: refresh after reset (agent, #1).");
    expect(executePin({ note: "refresh after reset; never touch SSO", name: "auth-plan" }, s.host, s.sm))
      .toBe("Redefined [3] auth-plan: refresh after reset; never touch SSO (agent, #1). It replaces [1] auth-plan: refresh after reset (agent, #1).");
    expect(readPins(s.entries)).toEqual([[2, "an unnamed note", "agent"], [3, "auth-plan: refresh after reset; never touch SSO", "agent"]]);
    expect(executePin({ note: "x", name: "no spaces here" }, s.host, s.sm)).toStartWith("Not a name: \"no spaces here\".");
    expect(executePin({ unpin: "auth-plan" }, s.host, s.sm)).toBe("Unpinned [3] auth-plan: refresh after reset; never touch SSO (agent, #1).");
    expect(readPins(s.entries).map(([id]) => id)).toEqual([2]);
  });

  it("the command names a note with name:NAME", async () => {
    const s = session([message("m1")]);
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const notices: string[] = [];
    registerPinCommands({ registerCommand: (name: string, c: any) => commands.set(name, c.handler), appendEntry: s.host.appendEntry, sendMessage: () => {} } as any, ompBinding);
    const ctx = { sessionManager: s.sm, ui: { notify: (m: string) => notices.push(m) } };
    await commands.get("keel-pin")!("name:test-cmd bun test tests/auth", ctx);
    expect(notices.at(-1)).toBe("Pinned [1] test-cmd: bun test tests/auth (user, #0).");
    await commands.get("keel-pin")!("Note: name:x is not at the start", ctx);
    expect(notices.at(-1)).toBe("Pinned [2] Note: name:x is not at the start (user, #0).");
    await commands.get("keel-unpin")!("test-cmd", ctx);
    expect(readPins(s.entries).map(([id]) => id)).toEqual([2]);
  });
});

describe("the user's notes", () => {
  it("stay as the user pinned them: the agent can neither define their name again nor unpin them", async () => {
    const s = session([message("m1")]);
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    registerPinCommands({ registerCommand: (name: string, c: any) => commands.set(name, c.handler), appendEntry: s.host.appendEntry, sendMessage: () => {} } as any, ompBinding);
    const ctx = { sessionManager: s.sm, ui: { notify: () => {} } };
    await commands.get("keel-pin")!("name:deploy only from main", ctx);
    expect(executePin({ note: "deploy from any branch", name: "deploy" }, s.host, s.sm))
      .toBe("[1] deploy: only from main (user, #0) is the user's note and stays: only the user has it defined again (/…-pin, /…-unpin). Tell the user what should change, or pin yours under another name.");
    expect(executePin({ unpin: "deploy" }, s.host, s.sm)).toStartWith("[1] deploy: only from main (user, #0) is the user's note and stays: only the user has it unpinned");
    expect(readPins(s.entries)).toEqual([[1, "deploy: only from main", "user"]]);
    // The agent's own notes it changes freely; the user changes theirs.
    expect(executePin({ note: "v1", name: "plan" }, s.host, s.sm)).toStartWith("Pinned [2] plan: v1");
    expect(executePin({ note: "v2", name: "plan" }, s.host, s.sm)).toStartWith("Redefined [3] plan: v2");
    await commands.get("keel-pin")!("name:deploy from main or release/*", ctx);
    expect(readPins(s.entries).map(([, text]) => text)).toEqual(["plan: v2", "deploy: from main or release/*"]);
  });
});

describe("named notes across sessions", () => {
  it("a new session starts with the user's named notes of the project's last one, once", () => {
    const dir = freshDir();
    const old = join(dir, "2026-01-01_aaaa1111.jsonl");
    writeJsonl(old, [
      { type: "session", id: "aaaa1111-0000", cwd: "/x" },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } },
      { type: "custom", id: "p1", parentId: "m1", customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 1, name: "plan", text: "ship v2", by: "agent", at: 0 } },
      { type: "custom", id: "p2", parentId: "p1", customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 2, text: "an unnamed note", by: "user", at: 0 } },
      { type: "custom", id: "p3", parentId: "p2", customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 3, name: "deploy", text: "only from main", by: "user", at: 0 } },
    ]);
    utimesSync(old, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const file = join(dir, "2026-01-02_bbbb2222.jsonl");
    writeJsonl(file, [{ type: "session", id: "bbbb2222-0000", cwd: "/x" }]);
    const s = session();
    const sm = { ...s.sm, getSessionFile: () => file, getSessionDir: () => dir };
    // The user's named notes only: the agent's stay with their session (it can read them there and pin again).
    expect(carryPins(s.host, ompBinding, { sessionManager: sm } as any)).toBe("Carried from the last session: [1] deploy: only from main (user, from session aaaa1111).");
    expect(readPins(s.entries)).toEqual([[1, "deploy: only from main", "user"]]);
    // Carried once: the session has pins now.
    expect(carryPins(s.host, ompBinding, { sessionManager: sm } as any)).toBeUndefined();
    // A session with a message in it already (resumed, forked) carries nothing.
    const t = session([message("m9")]);
    expect(carryPins(t.host, ompBinding, { sessionManager: { ...t.sm, getSessionFile: () => file, getSessionDir: () => dir } } as any)).toBeUndefined();
  });
});

describe("/keel-pin and /keel-unpin", () => {
  it("pin, tell the agent on its next turn, list, unpin", async () => {
    const s = session([message("m1")]);
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const sent: any[] = [];
    const notices: string[] = [];
    registerPinCommands({
      registerCommand: (name: string, c: any) => commands.set(name, c.handler),
      appendEntry: s.host.appendEntry,
      sendMessage: (m: any, o: any) => sent.push({ m, o }),
    } as any, ompBinding);
    const ctx = { sessionManager: s.sm, ui: { notify: (m: string) => notices.push(m) } };
    await commands.get("keel-pin")!("never edit migrations/", ctx);
    expect(notices.at(-1)).toBe("Pinned [1] never edit migrations/ (user, #0).");
    expect(sent[0]).toEqual({
      m: { customType: "keel-pin", content: "The user pinned [1] never edit migrations/ (user, #0). It stays at the top of every summary.", display: true },
      o: { deliverAs: "nextTurn" },
    });
    await commands.get("keel-pin")!("", ctx);
    expect(notices.at(-1)).toContain("- [1] never edit migrations/");
    await commands.get("keel-unpin")!("1", ctx);
    expect(readPins(s.entries)).toEqual([]);
    expect(sent.at(-1).m.content).toContain("The user unpinned [1]");
  });
});

describe("pinned notes in summaries", () => {
  let dir: string;
  const prev = process.env.KEEL_CONFIG_PATH;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "keel-pins-"));
    process.env.KEEL_CONFIG_PATH = join(dir, "c.json");
    writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false }));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.KEEL_CONFIG_PATH;
    else process.env.KEEL_CONFIG_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("come first in the summary, verbatim", () => {
    const s = session([message("m1", "user", "first request here"), message("m2", "assistant", "ok"), message("m3", "user", "second request here"), message("m4", "assistant", "ok")]);
    executePin({ note: "never edit migrations/" }, s.host, s.sm);
    let handler: any;
    const hook = registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    hook.autoCompactionStart("threshold");
    const out = handler({
      type: "session_before_compact", branchEntries: s.entries, customInstructions: undefined,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 100 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} }, sessionManager: s.sm });
    // Pinned notes first, then where the work stands.
    expect(out.compaction.summary.startsWith("[Pinned Notes]\n- [1] never edit migrations/ (agent, #3)\n\n[Task State]\n")).toBe(true);
  });

  it("the notice /keel-pin sends the agent is not repeated in the transcript", () => {
    const notice = { type: "custom_message", id: "n1", customType: "keel-pin", content: "The user pinned [1] never edit migrations/ (user, #3). It stays at the top of every summary.", display: true, timestamp: "2026-01-01T00:00:00.000Z" };
    const s = session([message("m1", "user", "first request here"), message("m2", "assistant", "ok"), notice, message("m3", "user", "second request here"), message("m4", "assistant", "ok")]);
    executePin({ note: "never edit migrations/" }, s.host, s.sm);
    let handler: any;
    registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
    const out = handler({
      type: "session_before_compact", branchEntries: s.entries, customInstructions: "__keel__ keep:1",
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 100 },
      signal: new AbortController().signal,
    }, { ui: { notify: () => {} }, sessionManager: s.sm });
    expect(out.compaction.summary).toContain("[Pinned Notes]\n- [1] never edit migrations/");
    expect(out.compaction.summary).not.toContain("The user pinned");
  });
});
