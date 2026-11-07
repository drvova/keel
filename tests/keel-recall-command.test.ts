import { ompBinding } from "./support/binding";
import { describe, it, expect } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { freshDir, sessionFileOfEntries } from "./support/session-files";
import { registerKeelRecallCommand } from "../src/commands/keel-recall";

// The search header and truncation note come from the core recall() both
// surfaces share (tests/recall-quality.test.ts); these check what the command
// adds: its own follow-up syntax, and one message sent to the agent.

const userMsg = (id: string, content: string) => ({
  type: "message",
  id,
  message: { role: "user", content },
});

/** A session of N user messages, the Ith saying textOf(I). */
const makeSession = (n: number, textOf: (i: number) => string) => {
  const entries = Array.from({ length: n }, (_, i) => userMsg(`m${i}`, textOf(i)));
  return { ...sessionFileOfEntries(entries), ids: entries.map((e) => e.id) };
};

const register = () => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const sent: Array<{ customType: string; content: string; display: boolean }> = [];
  const pi = {
    registerCommand: (name: string, command: { handler: typeof handler }) => {
      expect(["keel-recall", "omp-vcc-recall"]).toContain(name);
      handler ??= command.handler;
    },
    sendMessage: (msg: any) => {
      sent.push(msg);
    },
  } as any;
  registerKeelRecallCommand(pi, ompBinding);
  return { handler: handler!, sent };
};

const invoke = async (handler: (args: string, ctx: any) => Promise<void>, file: string, ids: string[], args: string) => {
  await handler(args, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => ids.map((id) => ({ id })),
      getEntries: () => ids.map((id) => ({ id })),
    },
    ui: { notify: () => {} },
  });
};

describe("/keel-recall paging hints", () => {
  it("reports an explicit out-of-range page (not a false 'No matches') using /keel-recall syntax, without duplicating 'refine your query'", async () => {
    // 60 raw matches capped to 50 → pages 1-10 exist. Page 11 has no rows to
    // slice, but hits.length (50) is > 0 — must not claim "No matches", and
    // since this IS a truncated result, the guidance must not repeat the
    // "refine your query" suggestion the truncation note already gave.
    const { dir, file, ids } = makeSession(60, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const { handler, sent } = register();
      await invoke(handler, file, ids, "zebra_query_tag.*entry page:11");

      const content = sent[0].content;
      expect(content).toContain("Page 11 is outside the available range 1-10");
      expect(content).toContain("50 matches");
      expect(content).not.toContain("No matches");
      expect(content).toContain("/keel-recall");
      expect(content).toContain("page:N");
      // "refine your query" must appear exactly once (from the truncation
      // note), not again in the out-of-range guidance.
      expect(content.match(/refine your query/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the scope:all label through an out-of-range page response", async () => {
    const { dir, file, ids } = makeSession(60, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const { handler, sent } = register();
      await invoke(handler, file, ids, "zebra_query_tag.*entry scope:all page:11");

      const content = sent[0].content;
      expect(content).toContain("(scope: all)");
      expect(content).toContain("scope:all");
      expect(content).toContain("Page 11 is outside the available range 1-10");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Issue #1: a brand-new session has no JSONL on disk yet.
describe("/keel-recall in a fresh session with no session file on disk", () => {
  const freshSessionFile = () => {
    const dir = freshDir();
    return { dir, file: join(dir, "sessions", "not-written-yet.jsonl") };
  };

  it("no-query path answers with the empty-history message instead of throwing ENOENT", async () => {
    const { dir, file } = freshSessionFile();
    try {
      const { handler, sent } = register();
      await invoke(handler, file, [], "");

      expect(sent).toHaveLength(1);
      expect(sent[0].content).toBe("No entries in session history.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("query path answers with the no-match message instead of throwing ENOENT", async () => {
    const { dir, file } = freshSessionFile();
    try {
      const { handler, sent } = register();
      await invoke(handler, file, [], "redis cache decision");

      expect(sent).toHaveLength(1);
      expect(sent[0].content).toBe('No matches for "redis cache decision" in session history.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
