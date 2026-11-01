/**
 * Long-horizon benchmark: one synthetic coding session with planted facts,
 * compacted every N turns through the real hook, scored at the end.
 *
 *   bun run scripts/benchmark-long-horizon.ts [turns] [compactEvery]
 *
 * Columns: summary = the fact's text is in the final summary; pointer = the
 * summary has its exact (#N) ref or a [History Index] range naming it; recall =
 * rank of its entry on page 1 of a reworded vcc_recall query (- = not found).
 */
import { runLongHorizon } from "../tests/support/long-horizon";

const turns = Number(process.argv[2] ?? 60);
const every = Number(process.argv[3] ?? 6);

for (const t of [turns, turns * 2]) {
  const r = runLongHorizon({ turns: t, compactEvery: every });
  console.log(`\n${t} turns, compacted every ${every} -> ${r.compactions} compactions; summary chars first/max/last: ${r.summaryChars[0]}/${Math.max(...r.summaryChars)}/${r.summaryChars.at(-1)}`);
  console.log("kind          turn  summary  pointer  recall");
  for (const n of r.needles) {
    console.log(`${n.kind.padEnd(13)} ${String(n.turn).padStart(4)}  ${(n.inSummary ? "yes" : "no").padEnd(7)}  ${(n.pointed ? "yes" : "no").padEnd(7)}  ${n.recallRank ?? "-"}`);
  }
  const k = r.needles.length;
  console.log(`totals: summary ${r.needles.filter((n) => n.inSummary).length}/${k}, pointer ${r.needles.filter((n) => n.pointed).length}/${k}, recall@5 ${r.needles.filter((n) => n.recallRank != null).length}/${k}`);
}
