/**
 * Long-horizon benchmark: a coding session with planted facts, worked through by
 * a real model in omp with omp-vcc loaded (tests/support/long-horizon.ts), scored
 * at the end. It runs on DeepSeek V4.1 Flash on OpenScale, as the tests do:
 *
 *   OMP_VCC_LH_API_KEY=… bun run scripts/benchmark-long-horizon.ts [turns] [compactEvery] [contextWindow]
 *
 * omp's idle pass runs every `compactEvery` turns, and omp compacts on its own
 * when the context passes its trigger. The window omp is told defaults to 128K;
 * the budgets and section sizes follow omp's trigger on it (core/window.ts).
 * `all` runs 32K, 128K and 1M. Each turn is a model turn: expect minutes per
 * 10 turns.
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
  const r = await runLongHorizon({ turns: t, compactEvery: every, contextWindow });
  const label = contextWindow ? `, ${Math.round(contextWindow / 1000)}K window` : "";
  console.log(`\n${t} turns, omp's idle pass every ${every}${label} -> ${r.compactions} compactions (${r.byOmpVcc} by omp-vcc); summary chars first/max/last: ${r.summaryChars[0]}/${Math.max(...r.summaryChars)}/${r.summaryChars.at(-1)}`);
  console.log("kind          turn  summary  pointer  recall");
  for (const n of r.needles) {
    console.log(`${n.kind.padEnd(13)} ${String(n.turn).padStart(4)}  ${(n.inSummary ? "yes" : "no").padEnd(7)}  ${(n.pointed ? "yes" : "no").padEnd(7)}  ${n.recallRank ?? "-"}`);
  }
  const k = r.needles.length;
  console.log(`totals: summary ${r.needles.filter((n) => n.inSummary).length}/${k}, pointer ${r.needles.filter((n) => n.pointed).length}/${k}, recall@5 ${r.needles.filter((n) => n.recallRank != null).length}/${k}`);
}
