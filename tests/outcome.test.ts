// What a compaction's outcome is told as, what /omp-vcc says when its
// compaction did not happen (src/commands/compact-feedback.ts), whose details a
// compaction entry carries, and the provider opt-out: lisp/src/outcome.lisp, case by case.
import { describe, expect, it } from "bun:test";
import { reportCompactError } from "../src/commands/compact-feedback";
import type { VccSettings } from "../src/core/settings";
import { core } from "../src/core/lisp-core";
import { ompBinding } from "./support/binding";

const outcomeLine = (stats: object): string => core({ op: "outcome", stats }).line as string;
/** omp-vcc's details on a compaction entry (omp's notes-backed rollover nests them under hookDetails), or undefined. */
const ownDetails = (details: unknown) => (core({ op: "outcome", details: details ?? null }).own as object | undefined) ?? undefined;
/** Whether omp-vcc answers the host's own compactions for a model of this provider. */
const handlesHostCompactions = (settings: VccSettings, provider: unknown): boolean => core({ op: "outcome", settings, provider: provider ?? null }).handles === true;

const base = { summarized: 40, keptUserTurns: 2, totalUserTurns: 9 };

describe("the outcome line", () => {
  it.each([
    [{ keptTokensEst: 999 }, "omp-vcc: kept 2/9 turns, ~999 tok (summarized 40)."],
    // Tenths as toFixed rounds them: a tie goes up.
    [{ keptTokensEst: 1050 }, "omp-vcc: kept 2/9 turns, ~1.1k tok (summarized 40)."],
    [{ keptTokensEst: 1250 }, "omp-vcc: kept 2/9 turns, ~1.3k tok (summarized 40)."],
    [{ keptTokensEst: 12_345, smartKeepAdjusted: true }, "omp-vcc: kept 2/9 turns, ~12.3k tok (summarized 40, smart-keep)."],
    [{ keptTokensEst: 3000, budgetCut: "final_reply" }, "omp-vcc: kept the final reply (~3.0k tok), summarized 40."],
    [{ keptTokensEst: 3000, budgetCut: "running_turn" }, "omp-vcc: kept the running turn's latest steps (~3.0k tok), summarized 40."],
    [{ keptTokensEst: 950, budgetCut: "no_anchor" }, "omp-vcc: kept ~950 tok tail (mid-turn cut, no user anchor), summarized 40."],
    [{ keptTokensEst: 99_950, budgetCut: "oversized_tail" }, "omp-vcc: kept ~100.0k tok tail (mid-turn cut, oversized tail), summarized 40."],
  ])("%j", (stats, line) => {
    expect(outcomeLine({ ...base, ...stats } as any)).toBe(line);
  });
});

describe("what /omp-vcc says when its compaction did not happen", () => {
  const told = (message: string, mode: string, notice: string | null, branch: unknown[] = []) => {
    const out: unknown[] = [];
    reportCompactError(ompBinding, { mode, hasUI: true, ui: { notify: (m: string, t: string) => out.push([m, t]) }, sessionManager: { getBranch: () => branch } } as any, new Error(message), notice);
    return out;
  };

  it("adds nothing to a cancel the hook explained, nor to omp's TUI, which shows its own", () => {
    expect(told("Compaction cancelled", "rpc", "omp-vcc: Too few messages to compact")).toEqual([]);
    expect(told("boom", "tui", null)).toEqual([]);
  });

  it("says why otherwise", () => {
    expect(told("Compaction cancelled", "rpc", null)).toEqual([["Nothing to compact", "warning"]]);
    expect(told("Already compacted", "rpc", null)).toEqual([["Nothing to compact: the session was just compacted.", "warning"]]);
    expect(told("boom", "rpc", null)).toEqual([["Compaction failed: boom", "error"]]);
  });

  it("explains the host's own refusal, after a compaction or before any, in its TUI too", () => {
    expect(told("Nothing to compact", "tui", null, [{ type: "compaction", id: "c1" }])).toEqual([[
      "Nothing to compact yet: what came after the last compaction still fits in the recent part omp always keeps (compaction.keepRecentTokens in omp settings). Try again after a few more turns.",
      "warning",
    ]]);
    expect(told("Nothing to compact", "rpc", null)).toEqual([[
      "Nothing to compact yet: the whole session still fits in the recent part omp always keeps (compaction.keepRecentTokens in omp settings). Try again once the session is longer.",
      "warning",
    ]]);
  });
});

describe("whose details a compaction carries", () => {
  it("omp-vcc's and pi-vcc's, also nested under omp's notes-backed rollover; none of another compactor's", () => {
    expect(ownDetails({ compactor: "pi-vcc", willRetry: true })).toEqual({ compactor: "pi-vcc", willRetry: true });
    expect(ownDetails({ compactor: "other", hookDetails: { compactor: "omp-vcc", reason: "idle" } })).toEqual({ compactor: "omp-vcc", reason: "idle" });
    expect(ownDetails({ compactor: "other" })).toBeUndefined();
    expect(ownDetails(null)).toBeUndefined();
  });
});

describe("the provider opt-out", () => {
  const settings = (override: boolean, skip: string[]) => ({ overrideDefaultCompaction: override, skipForProviders: skip } as VccSettings);

  it("answers every provider but the ones skipped, in any case, unless the user opted out", () => {
    expect(handlesHostCompactions(settings(true, []), "anthropic")).toBe(true);
    expect(handlesHostCompactions(settings(true, ["Anthropic"]), "ANTHROPIC")).toBe(false);
    expect(handlesHostCompactions(settings(false, []), "anthropic")).toBe(false);
    // An unknown provider never skips.
    expect(handlesHostCompactions(settings(true, ["anthropic"]), undefined)).toBe(true);
  });

  it("compares as toLowerCase does, Unicode's case mapping included", () => {
    expect(handlesHostCompactions(settings(true, ["İSTANBUL"]), "i̇stanbul")).toBe(false);
    expect(handlesHostCompactions(settings(true, ["οδος"]), "ΟΔΟΣ")).toBe(false);
    expect(handlesHostCompactions(settings(true, ["strasse"]), "Straße")).toBe(true);
  });
});
