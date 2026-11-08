// Detail lost compaction after compaction ("recursive information decay",
// CogCanvas, arXiv:2601.00821): a summary pass that rewrites the last summary
// drops a qualifier here and there until a hard constraint reads as a
// preference. keel merges each compaction from the state the previous one
// stored, never from its text, so what it carries must read the same after ten
// compactions as after one, and the summary must stay bounded as the session
// grows. This runs ten in a row on one growing session.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerHook } from "./support/host";
import { COMPACT_INSTRUCTION, PIN_ENTRY_TYPE } from "./support/names";

let dir: string;
const prev = process.env.KEEL_CONFIG_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-decoherence-"));
  process.env.KEEL_CONFIG_PATH = join(dir, "keel-config.json");
  writeFileSync(process.env.KEEL_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, evict: false }));
});
afterAll(() => {
  if (prev === undefined) delete process.env.KEEL_CONFIG_PATH;
  else process.env.KEEL_CONFIG_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

const FIRST = "Fix the login bug. Never touch migrations/ — they are generated, and a hand edit breaks the next deploy.";
const PINNED = "Deploy only from main, never from a release branch.";
const MIDWAY = "From now on run bun test tests/auth before every commit, not the whole suite.";

/** Ten rounds of work, each four turns ending in a compaction (keep:1); what each compaction wrote. */
const rounds = (count: number) => {
  let handler: any;
  registerHook({ on: (name: string, fn: any) => { if (name === "session_before_compact") handler = fn; } });
  const branch: any[] = [];
  let t = 1_700_000_000_000;
  const add = (entry: any) => branch.push({ id: `e${branch.length}`, parentId: branch.at(-1)?.id ?? null, ...entry });
  const say = (role: string, content: unknown) => add({ type: "message", message: { role, content, timestamp: t++ } });
  say("user", FIRST);
  add({ type: "custom", customType: PIN_ENTRY_TYPE, data: { v: 1, op: "add", id: 1, text: PINNED, by: "user", at: 1 } });
  const summaries: string[] = [];
  const told: string[] = [];
  for (let r = 0; r < count; r++) {
    for (let k = 0; k < 4; k++) {
      const i = r * 4 + k;
      say("user", r === 1 && k === 0 ? MIDWAY : `Turn ${i}: update the ${["auth", "billing", "search", "upload"][k]} service so that retries back off (src/${k}/service.ts).`);
      say("assistant", [{ type: "toolCall", id: `c${i}`, name: "edit", arguments: { path: `src/${k}/service.ts`, oldText: `retry${i}`, newText: `backoff${i}` } }]);
      say("toolResult", [{ type: "text", text: `Edited src/${k}/service.ts\n${Array.from({ length: 300 }, (_, j) => `  ${j}: const retry${i}_${j} = backoff(${j});`).join("\n")}` }]);
      branch.at(-1).message.toolCallId = `c${i}`;
      say("assistant", [{ type: "text", text: `Done with turn ${i}: retries back off now, tests pass. ${"detail ".repeat(60)}` }]);
    }
    const reply = handler(
      { type: "session_before_compact", customInstructions: `${COMPACT_INSTRUCTION} keep:1`, branchEntries: [...branch],
        // As both hosts hand it: the last compaction's summary text, whose stored state keel merges into.
        preparation: { tokensBefore: 50_000, previousSummary: summaries.at(-1), fileOps: { read: [], written: [], edited: [] } } },
      { sessionManager: { getEntries: () => branch, getBranch: () => branch }, ui: { notify: (m: string) => told.push(m) } },
    );
    if (!reply?.compaction) throw new Error(`round ${r} was not compacted: ${told.join(" | ")}`);
    const { summary, details, firstKeptEntryId } = reply.compaction;
    summaries.push(summary);
    // The host applies it: a compaction entry the next pass reads its stored state from.
    add({ type: "compaction", summary, details, firstKeptEntryId });
  }
  return summaries;
};

describe("ten compactions in a row", () => {
  let summaries: string[] = [];
  beforeAll(() => { summaries = rounds(10); });

  it("keep the first request's constraint word for word, qualifier and all", () => {
    for (const s of summaries) expect(s).toContain("Never touch migrations/ — they are generated, and a hand edit breaks the next deploy.");
  });

  it("keep a pinned constraint word for word", () => {
    for (const s of summaries) expect(s).toContain(PINNED);
  });

  it("keep the history behind them indexed from #0", () => {
    for (const s of summaries.slice(1)) expect(s).toMatch(/\[History Index\]\n- #0–#\d+/);
  });

  it("stay bounded as the session grows: once the sections fill, five more compactions add under a tenth", () => {
    // The first few grow as the sections fill (early requests, the history index);
    // after that each section is capped and the summary levels off.
    expect(summaries[9].length).toBeLessThanOrEqual(Math.ceil(summaries[4].length * 1.1));
  });

  it("a constraint said once mid-session ages out of [User Messages] unless it is pinned: the decay keel leaves to pins", () => {
    // Stated in round 1: still there two compactions on, gone by the tenth. This is
    // the decay a structured state does not prevent on its own; pinning it does.
    expect(summaries[1]).toContain(MIDWAY);
    expect(summaries[9]).not.toContain(MIDWAY);
  });
});
