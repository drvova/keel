// Detail lost compaction after compaction ("recursive information decay",
// CogCanvas, arXiv:2601.00821): a summary pass that rewrites the last summary
// drops a qualifier here and there until a hard constraint reads as a
// preference. keel merges each compaction from the state the previous one
// stored, never from its text, so what it carries must read the same after ten
// compactions as after one, and the summary must stay bounded as the session
// grows. This runs ten in a row on one growing session.
import { beforeAll, describe, expect, it } from "bun:test";
import { registerHook } from "./support/host";
import { COMPACT_INSTRUCTION, PIN_ENTRY_TYPE } from "./support/names";
import { tempConfig } from "./support/config";

const config = tempConfig("keel-decoherence-", { overrideDefaultCompaction: true, evict: false });

const FIRST = "Fix the login bug. Never touch migrations/ — they are generated, and a hand edit breaks the next deploy.";
const PINNED = "Deploy only from main, never from a release branch.";
const MIDWAY = "From now on run bun test tests/auth before every commit, not the whole suite.";

/** Ten rounds of work, each four turns ending in a compaction (keep:1); what each compaction wrote. */
/** What the user says at turn K of round R: the default plants MIDWAY once, in round 1. */
type Said = (r: number, k: number) => string;
const saidOnce: Said = (r, k) => (r === 1 && k === 0 ? MIDWAY : `Turn ${r * 4 + k}: update the ${["auth", "billing", "search", "upload"][k]} service so that retries back off (src/${k}/service.ts).`);

const rounds = (count: number, saying: Said = saidOnce) => {
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
      say("user", saying(r, k));
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

  it("keep a constraint said once mid-session in [User Messages] while it is recent", () => {
    // Stated in round 1. [User Messages] is capped, so it ages out later on: pinning it is what keeps it.
    expect(summaries[1]).toContain(MIDWAY);
  });
});

describe("what the user says again, after a gap", () => {
  const AGAIN = "Run bun test tests/auth before every commit, not the whole suite — the full suite takes twenty minutes.";
  // The rule said in round 1 and again, with words added, in round 3; every other turn follows one template, each naming its own file.
  // Each turn's request names its own file, as real requests do: the template's words weigh little.
  const work = (r: number, k: number) => `Turn ${r * 4 + k}: update the ${["auth", "billing", "search", "upload"][k]} service so that retries back off (src/${k}/handler${r * 4 + k}.ts).`;
  const said = (r: number, k: number) =>
    r === 1 && k === 0 ? AGAIN
      : r === 3 && k === 0 ? `Again, as I said: ${AGAIN} Please keep to it.`
      : work(r, k);
  let summaries: string[] = [];
  beforeAll(() => { summaries = rounds(10, said); });

  it("stays in [User Messages] long after the newest have pushed its first wording out, marked as said more than once", () => {
    expect(summaries[9]).toContain("(said more than once) Again, as I said: Run bun test tests/auth before every commit");
  });

  it("is not set off by a template the user follows turn after turn", () => {
    expect(summaries[9].match(/\(said more than once\)/g) ?? []).toHaveLength(1);
  });

  it("leaves a rule said once to age out as before", () => {
    const once = rounds(10, (r, k) => (r === 1 && k === 0 ? AGAIN : work(r, k)));
    expect(once[9]).not.toContain("(said more than once)");
  });
});
