/**
 * Long-horizon benchmark: one synthetic coding session with planted facts,
 * compacted every N turns through the real hook, scored at the end.
 *
 *   bun run scripts/benchmark-long-horizon.ts [turns] [compactEvery] [contextWindow]
 *
 * Without a context window, no model: the ~128K defaults. With one, each
 * compaction runs at omp's default trigger on it, and the budgets and section
 * sizes follow it (core/window.ts). `all` runs 32K, 128K and 1M.
 *
 * Columns: summary = the fact's text is in the final summary; pointer = the
 * summary has its exact (#N) ref or a [History Index] range naming it; recall =
 * rank of its entry on page 1 of a reworded vcc_recall query (- = not found).
 */
import { runLongHorizon } from "../tests/support/long-horizon";

const turns = Number(process.argv[2] ?? 60);
const every = Number(process.argv[3] ?? 6);
const windowArg = process.argv[4];
const windows: Array<number | undefined> = windowArg === "all" ? [32_768, 128_000, 1_000_000] : [windowArg ? Number(windowArg) : undefined];

for (const contextWindow of windows) for (const t of [turns, turns * 2]) {
  const r = runLongHorizon({ turns: t, compactEvery: every, contextWindow });
  const label = contextWindow ? `, ${Math.round(contextWindow / 1000)}K window` : "";
  console.log(`\n${t} turns, compacted every ${every}${label} -> ${r.compactions} compactions; summary chars first/max/last: ${r.summaryChars[0]}/${Math.max(...r.summaryChars)}/${r.summaryChars.at(-1)}`);
  console.log("kind          turn  summary  pointer  recall");
  for (const n of r.needles) {
    console.log(`${n.kind.padEnd(13)} ${String(n.turn).padStart(4)}  ${(n.inSummary ? "yes" : "no").padEnd(7)}  ${(n.pointed ? "yes" : "no").padEnd(7)}  ${n.recallRank ?? "-"}`);
  }
  const k = r.needles.length;
  console.log(`totals: summary ${r.needles.filter((n) => n.inSummary).length}/${k}, pointer ${r.needles.filter((n) => n.pointed).length}/${k}, recall@5 ${r.needles.filter((n) => n.recallRank != null).length}/${k}`);
}
