import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listProjectSessions, MAX_LISTED_SESSIONS, resolveSession, type SessionInfo } from "../src/core/sessions";
import { executeRecall } from "../src/tools/recall";
import { parseCommandRequest, sessionRef } from "../src/core/recall-request";
import { PIN_ENTRY_TYPE } from "../src/names";

const header = (id: string, ts: string) => ({ type: "session", version: 3, id, timestamp: ts, cwd: "/work/app" });
let n = 0;
const msg = (role: "user" | "assistant", text: string, parentId: string | null) => {
  const id = `m${++n}`;
  return { type: "message", id, parentId, timestamp: "2026-10-01T00:00:00.000Z", message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] } };
};
const chain = (texts: Array<["user" | "assistant", string]>, start: string | null = null) => {
  const out: any[] = [];
  let parent = start;
  for (const [role, text] of texts) {
    const e = msg(role, text, parent);
    out.push(e);
    parent = e.id;
  }
  return out;
};
const write = (file: string, lines: unknown[], mtime: number) => {
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(file, mtime, mtime);
};

let dir: string;
let current: string;
let sessions: SessionInfo[];
const sm = (branch: any[]) => ({ getSessionFile: () => current, getSessionDir: () => dir, getBranch: () => branch, getEntries: () => branch });
let currentBranch: any[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-vcc-sessions-"));
  // An earlier session: a fact and a pinned note.
  const a = chain([["user", "Ship the release and tag it"], ["assistant", "Deploy tag v2.14.7 was rolled back after the smoke test failed."]]);
  write(join(dir, "2026-10-01T10-00-00-000Z_aaaa1111-0000-7000-8000-000000000001.jsonl"), [
    header("aaaa1111-0000-7000-8000-000000000001", "2026-10-01T10:00:00.000Z"),
    ...a,
    { type: "custom", id: "p1", parentId: a[1].id, customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 1, text: "never deploy on Fridays", by: "user" } },
  ], 1_000);
  // Earlier omp session: title slot first, and an abandoned branch.
  const b = chain([["user", "Migrate the billing cron"], ["assistant", "Moved the cron to the queue worker."]]);
  const abandoned = msg("assistant", "An abandoned attempt mentioning zebracorn.", b[0].id);
  write(join(dir, "2026-10-02T10-00-00-000Z_bbbb2222-0000-7000-8000-000000000002.jsonl"), [
    { type: "title", v: 1, title: "Billing cron move", updatedAt: "2026-10-02T10:00:00.000Z", pad: "   " },
    header("bbbb2222-0000-7000-8000-000000000002", "2026-10-02T10:00:00.000Z"),
    b[0], abandoned, b[1],
  ], 2_000);
  writeFileSync(join(dir, "notes.jsonl"), "not a session\n");
  // The current session.
  currentBranch = chain([["user", "Where were we with the release?"], ["assistant", "Checking."]]);
  current = join(dir, "2026-10-03T10-00-00-000Z_cccc3333-0000-7000-8000-000000000003.jsonl");
  write(current, [header("cccc3333-0000-7000-8000-000000000003", "2026-10-03T10:00:00.000Z"), ...currentBranch], 3_000);
  sessions = listProjectSessions(dir, current);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("listProjectSessions", () => {
  it("lists the other session files newest first, with title, first request, size and pins", () => {
    expect(sessions.map((s) => s.short)).toEqual(["bbbb2222", "aaaa1111"]);
    expect(sessions[0]).toMatchObject({ title: "Billing cron move", firstRequest: "Migrate the billing cron", messages: 3 });
    expect(sessions[1]).toMatchObject({ firstRequest: "Ship the release and tag it", messages: 2, pins: ["[1] never deploy on Fridays (user)"] });
  });
});

describe("an earlier session's pins", () => {
  it("are the ones on its active branch: a pin made on an abandoned branch is not", () => {
    const d = mkdtempSync(join(tmpdir(), "omp-vcc-sessions-pins-"));
    try {
      const root = msg("user", "Plan the migration", null);
      const pin = (id: string, parentId: string, noteId: number, text: string) =>
        ({ type: "custom", id, parentId, customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: noteId, text, by: "user" } });
      const abandoned = msg("assistant", "First try", root.id);
      const kept = msg("assistant", "Second try", root.id);
      write(join(d, "2026-10-01T10-00-00-000Z_dddd4444-0000-7000-8000-000000000004.jsonl"), [
        header("dddd4444-0000-7000-8000-000000000004", "2026-10-01T10:00:00.000Z"),
        root, abandoned, pin("p-old", abandoned.id, 1, "use the old schema"),
        kept, pin("p-new", kept.id, 2, "use the new schema"),
      ], 1_000);
      expect(listProjectSessions(d)[0].pins).toEqual(["[2] use the new schema (user)"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("resolveSession", () => {
  it("takes an id prefix, refuses short, unknown and ambiguous ones", () => {
    expect((resolveSession("aaaa", sessions) as SessionInfo).short).toBe("aaaa1111");
    expect((resolveSession(sessionRef("@bbbb2222-0000"), sessions) as SessionInfo).short).toBe("bbbb2222");
    expect(resolveSession("aa", sessions)).toHaveProperty("error");
    expect(resolveSession("ffff", sessions)).toHaveProperty("error");
    const twins = [{ ...sessions[0], id: "abcd1-x", short: "abcd1x" }, { ...sessions[1], id: "abcd2-y", short: "abcd2y" }];
    expect((resolveSession("abcd", twins) as { error: string }).error).toContain("matches 2 sessions");
  });
});

describe("vcc_recall across sessions", () => {
  it("mode:'sessions' lists them with their pins and how to read one", () => {
    const out = executeRecall({ mode: "sessions" }, sm(currentBranch));
    expect(out).toContain("2 earlier sessions in this project, newest first:");
    expect(out).toContain('bbbb2222 · 2026-10-02 10:00 · 3 messages · Billing cron move · "Migrate the billing cron"');
    expect(out).toContain("pinned: [1] never deploy on Fridays (user)");
    expect(out).toContain("session:'bbbb2222' with a query");
  });

  it("scope:'project' searches the earlier sessions too, and a hit names its session", () => {
    const out = executeRecall({ query: "rolled back release tag", scope: "project" }, sm(currentBranch));
    expect(out).toContain("in this session and 2 earlier sessions");
    expect(out).toMatch(/\[session aaaa1111\] #1 \[assistant\]/);
    expect(out).toContain("session:'aaaa1111', expand:[1]");
  });

  it("session:'id' reads that session, on its own active branch", () => {
    const expanded = executeRecall({ session: "aaaa1111", expand: [1] }, sm(currentBranch));
    expect(expanded.startsWith("Session aaaa1111 · ")).toBe(true);
    expect(expanded).toContain("Deploy tag v2.14.7 was rolled back");
    expect(executeRecall({ session: "bbbb", query: "zebracorn" }, sm(currentBranch))).toContain("Nothing on the current conversation path");
  });

  it("a session and scope:'project' together: the scope is named as ignored", () => {
    expect(executeRecall({ session: "aaaa", scope: "project", query: "release" }, sm(currentBranch))).toContain("Ignored: scope");
  });

  // Seen with a real model: its first searches looked only at the current session,
  // found nothing, and it took another request to think of the earlier ones.
  it("a search of this session that finds nothing names the earlier sessions", () => {
    const hint = "This project has 2 earlier sessions: scope:'project' searches them too; mode:'sessions' lists them.";
    expect(executeRecall({ query: "rolled back deploy tag" }, sm(currentBranch))).toBe(`No matches for "rolled back deploy tag" in session history.\n${hint}`);
    // Only the current turn matches: the same note after the in-turn one.
    expect(executeRecall({ query: "release" }, sm(currentBranch))).toBe(
      `No earlier matches for "release"; its 1 match is in the current turn, which is already in your context.\n${hint}`,
    );
    // scope:'project' (already searched them) or no earlier session: no note.
    expect(executeRecall({ query: "zzzz qqqq", scope: "project" }, sm(currentBranch))).not.toContain("scope:'project' searches");
    const alone = mkdtempSync(join(tmpdir(), "omp-vcc-alone-"));
    try {
      const file = join(alone, "s.jsonl");
      write(file, [header("dddd4444-0000-7000-8000-000000000004", "2026-10-04T10:00:00.000Z"), ...currentBranch], 4_000);
      const out = executeRecall({ query: "rolled back deploy tag" }, { ...sm(currentBranch), getSessionFile: () => file, getSessionDir: () => alone });
      expect(out).toBe('No matches for "rolled back deploy tag" in session history.');
    } finally {
      rmSync(alone, { recursive: true, force: true });
    }
  });

  it("an unknown session is an error with the way out", () => {
    expect(executeRecall({ session: "ffff", query: "x" }, sm(currentBranch))).toBe("No earlier session of this project starts with 'ffff'. mode:'sessions' lists them.");
  });
});

describe("/omp-vcc-recall arguments", () => {
  it("parses sessions, session:<id> and scope:project", () => {
    expect(parseCommandRequest("sessions").action).toEqual({ kind: "sessions", page: 1 });
    expect(parseCommandRequest("session:aaaa1111 rolled back")).toMatchObject({ session: "aaaa1111", action: { kind: "search", query: "rolled back" } });
    expect(parseCommandRequest("rolled back scope:project")).toMatchObject({ scope: "project", action: { kind: "search", query: "rolled back" } });
  });
});

describe("reading an earlier session", () => {
  it("names it in the follow-up calls it suggests, and finds one older than the listed ones", () => {
    const d = mkdtempSync(join(tmpdir(), "omp-vcc-sessions-older-"));
    try {
      const write1 = { type: "message", id: "w1", parentId: null, timestamp: "2026-10-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } }] } };
      const id = (n: number) => `${String(n).padStart(8, "0")}-0000-7000-8000-000000000000`;
      // The oldest session holds the write; MAX_LISTED_SESSIONS newer ones push it out of the listing.
      const oldId = "a0a0a0a0-0000-7000-8000-000000000000";
      write(join(d, `old_${oldId}.jsonl`), [header(oldId, "2026-10-01T00:00:00.000Z"), write1], 1_000);
      for (let n = 1; n <= MAX_LISTED_SESSIONS; n++) write(join(d, `s_${id(n)}.jsonl`), [header(id(n), "2026-10-02T00:00:00.000Z"), msg("user", `session ${n} here`, null)], 2_000 + n);
      const cur = join(d, "current.jsonl");
      write(cur, [header("ffffffff-0000-7000-8000-000000000000", "2026-10-03T00:00:00.000Z")], 9_000);
      const manager = { getSessionFile: () => cur, getSessionDir: () => d, getBranch: () => [], getEntries: () => [] };
      const touched = executeRecall({ session: "a0a0", mode: "touched" }, manager);
      expect(touched).toStartWith("Session a0a0a0a0");
      expect(touched).toContain("query:'#0:a.ts' with session:'a0a0a0a0'");
      expect(executeRecall({ mode: "sessions" }, manager)).toContain(`the newest ${MAX_LISTED_SESSIONS} (session:'id' reads an older one)`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
