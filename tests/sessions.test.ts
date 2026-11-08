import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// The project's other sessions (lisp/src/sessions.lisp): listed by mode:'sessions',
// searched by scope:'project', read by session:'id'.
import { executeRecall, fakeHost } from "./support/binding";
import { core } from "../src/core";
import { PIN_ENTRY_TYPE } from "./support/names";
import { writeJsonl } from "./support/session-files";

/** How many sessions a listing shows (lisp/src/sessions.lisp). */
const MAX_LISTED_SESSIONS = 50;
const parseCommandRequest = (args: string) => core({ op: "request", args }).request as Record<string, unknown>;

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
const write = writeJsonl;

let dir: string;
let current: string;
const sm = (branch: any[]) => ({ getSessionFile: () => current, getSessionDir: () => dir, getBranch: () => branch, getEntries: () => branch });
let currentBranch: any[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-sessions-"));
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
});

/** A session manager on an empty current session in DIR: every other file there is an earlier session. */
const emptyIn = (d: string) => {
  const file = join(d, "zz-current.jsonl");
  write(file, [header("ffffffff-0000-7000-8000-00000000ffff", "2026-10-09T10:00:00.000Z")], 99_000);
  return { getSessionFile: () => file, getSessionDir: () => d, getBranch: () => [], getEntries: () => [] };
};
/** The listing's lines of the sessions in DIR. */
const listing = (d: string): string[] => executeRecall({ mode: "sessions" }, emptyIn(d)).split("\n");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("mode:'sessions'", () => {
  it("lists a session by the first request the user wrote, read as the summary reads one", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "keel-first-request-"));
    try {
      const c = chain([["user", '<skill name="tdd">Write the test first.</skill>'], ["user", "ok"], ["user", "Add refunds to the ledger"], ["assistant", "Done."]]);
      write(join(skillDir, "s.jsonl"), [header("eeee5555-0000-7000-8000-000000000005", "2026-10-05T10:00:00.000Z"), ...c], 5_000);
      expect(listing(skillDir).find((l) => l.includes("eeee5555"))).toContain('"Add refunds to the ledger"');
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("gives sessions started within a minute short ids that tell them apart, and each names its session", () => {
    // omp's ids are UUIDv7: the first 8 characters are the start time's top bits.
    const twinDir = mkdtempSync(join(tmpdir(), "keel-twins-"));
    try {
      const ids = ["01a1af12-0000-7000-8000-00000000000a", "01a1af12-0001-7000-8000-00000000000b"];
      ids.forEach((id, i) => write(join(twinDir, `${i}.jsonl`), [header(id, "2026-10-06T10:00:00.000Z"), ...chain([["user", `twin request ${i}`]])], 6_000 + i));
      const shorts = listing(twinDir).flatMap((l) => l.match(/^(01a1af12\w*) · /)?.[1] ?? []);
      expect(shorts).toEqual(["01a1af120001", "01a1af120000"]);
      for (const [i, short] of [[1, shorts[0]], [0, shorts[1]]] as const) {
        expect(executeRecall({ session: short, expand: [0] }, emptyIn(twinDir))).toContain(`twin request ${i}`);
      }
      // A prefix both share names neither.
      expect(executeRecall({ session: "01a1", query: "x" }, emptyIn(twinDir))).toContain("matches 2 sessions");
    } finally {
      rmSync(twinDir, { recursive: true, force: true });
    }
  });

  it("names a Pi session by its /name, the latest one", () => {
    const piDir = mkdtempSync(join(tmpdir(), "keel-pi-names-"));
    try {
      const c = chain([["user", "Refactor the auth module"], ["assistant", "Done."]]);
      write(join(piDir, "pi.jsonl"), [
        header("dddd4444-0000-7000-8000-000000000004", "2026-10-04T10:00:00.000Z"),
        c[0],
        { type: "session_info", id: "n1", parentId: c[0].id, timestamp: "2026-10-04T10:01:00.000Z", name: "Auth refactor" },
        { type: "session_info", id: "n2", parentId: "n1", timestamp: "2026-10-04T10:02:00.000Z", name: "Auth refactor, part 2" },
        c[1],
      ], 4_000);
      expect(listing(piDir).find((l) => l.startsWith("dddd4444"))).toContain("· 2 messages · Auth refactor, part 2 ·");
    } finally {
      rmSync(piDir, { recursive: true, force: true });
    }
  });

  it("lists the other session files newest first, with title, first request, size and pins", () => {
    const lines = executeRecall({ mode: "sessions" }, sm(currentBranch)).split("\n");
    const at = (short: string) => lines.findIndex((l) => l.startsWith(short));
    expect(at("bbbb2222")).toBeLessThan(at("aaaa1111"));
    expect(lines[at("bbbb2222")]).toContain('3 messages · Billing cron move · "Migrate the billing cron"');
    expect(lines[at("aaaa1111")]).toContain('2 messages · "Ship the release and tag it"');
    expect(lines.slice(at("aaaa1111")).join("\n")).toContain("pinned: [1] never deploy on Fridays (user)");
  });
});

describe("an earlier session's pins", () => {
  it("are the ones on its active branch: a pin made on an abandoned branch is not", () => {
    const d = mkdtempSync(join(tmpdir(), "keel-sessions-pins-"));
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
      const out = listing(d).join("\n");
      expect(out).toContain("pinned: [2] use the new schema (user)");
      expect(out).not.toContain("use the old schema");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("session:'id'", () => {
  it("takes an id prefix, refuses short, unknown and ambiguous ones", () => {
    const read = (session: string) => executeRecall({ session, expand: [0] }, sm(currentBranch));
    expect(read("aaaa")).toStartWith("Session aaaa1111 · ");
    expect(read("@bbbb2222-0000")).toStartWith("Session bbbb2222 · ");
    for (const bad of ["aa", "ffff"]) expect(read(bad)).not.toStartWith("Session ");
  });
});

describe("keel_recall across sessions", () => {
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

  it("a hit off the current path is read around in its scope, both calls", () => {
    // zebracorn is on the abandoned branch of bbbb2222, at #1.
    expect(executeRecall({ session: "bbbb2222", query: "zebracorn", scope: "all" }, sm(currentBranch)))
      .toContain("\n--- Read around a hit: session:'bbbb2222', range:[0, 4], scope:'all'; full text: session:'bbbb2222', expand:[1], scope:'all' ---");
  });

  it("the command takes the quoted forms recall's own output shows", () => {
    expect(parseCommandRequest("session:'aaaa1111' release")).toMatchObject({ session: "aaaa1111", action: { kind: "search", query: "release" } });
    expect(parseCommandRequest("release scope:'project'")).toMatchObject({ scope: "project", action: { kind: "search", query: "release" } });
  });

  it("the next page of a search or a listing keeps its scope and session", () => {
    const d = mkdtempSync(join(tmpdir(), "keel-sessions-pages-"));
    try {
      // Seven hits on one branch, and seven files written: more than a page of each.
      const many = chain(Array.from({ length: 7 }, (_, i) => ["assistant", `the deploy note number ${i}`] as ["assistant", string]));
      const writes = Array.from({ length: 7 }, (_, i) => ({ type: "message", id: `w${i}`, parentId: i ? `w${i - 1}` : many.at(-1).id, timestamp: "2026-10-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "write", arguments: { path: `src/f${i}.ts`, content: "x" } }] } }));
      const id = "abab1212-0000-7000-8000-000000000000";
      write(join(d, `old_${id}.jsonl`), [header(id, "2026-10-01T00:00:00.000Z"), ...many, ...writes], 1_000);
      const manager = emptyIn(d);
      expect(executeRecall({ query: "deploy note", scope: "project" }, manager)).toContain("\n--- Use page:2 with scope:'project' for more results ---");
      expect(executeRecall({ session: "abab", query: "deploy note", scope: "all" }, manager)).toContain("\n--- Use page:2 with session:'abab1212' and scope:'all' for more results ---");
      // A listing that depends on the scope, too: mode:'touched' over every branch.
      expect(executeRecall({ session: "abab", mode: "touched", scope: "all" }, manager)).toContain("\n--- Use mode:'touched' page:2 with session:'abab1212' and scope:'all' for more results ---");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("the command, which has no read-around hint, gives none for a hit in an earlier session either", async () => {
    const h = fakeHost();
    await h.command("keel-recall", "rolled back release tag scope:project", { sessionManager: sm(currentBranch) });
    const text = h.sent.at(-1)?.message.content;
    expect(text).toMatch(/\[session aaaa1111\] #1 \[assistant\]/);
    expect(text).not.toContain("Read around a hit");
  });

  it("an entry that does not exist is only that: not also off the current path", () => {
    expect(executeRecall({ query: "#99:file" }, sm(currentBranch))).toBe("Entry #99 not found in session history.");
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
    const alone = mkdtempSync(join(tmpdir(), "keel-alone-"));
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

describe("reading an earlier session", () => {
  it("names it in the follow-up calls it suggests, and finds one older than the listed ones", () => {
    const d = mkdtempSync(join(tmpdir(), "keel-sessions-older-"));
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
