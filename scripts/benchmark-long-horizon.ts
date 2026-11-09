/**
 * Long-horizon benchmark: a coding session with planted facts, worked through by
 * a real model in omp (or Pi) with keel loaded (tests/support/long-horizon.ts),
 * scored at the end. It runs on DeepSeek V4.1 Flash on OpenScale, as the tests do:
 *
 *   KEEL_LH_API_KEY=… bun run scripts/benchmark-long-horizon.ts [turns] [compactEvery] [contextWindow] [--host=omp|pi] [--mode=keel|evict]
 *
 * omp's idle pass (on Pi, which has none, Pi's /compact) runs every
 * `compactEvery` turns, and the host compacts on its own when the context passes
 * its trigger. The window omp is told defaults to 128K;
 * the budgets and section sizes follow omp's trigger on it (lisp/src/window.lisp).
 * `all` runs 32K, 128K and 1M. Each turn is a model turn: expect minutes per
 * 10 turns.
 *
 * --mode=evict turns on keel's eviction (`"evict": true`): old turns leave the
 * context whole, and omp's threshold and idle passes are turned down.
 *
 * Columns: summary = the fact's text is in the final summary; pointer = the
 * summary has its exact (#N) ref or a [History Index] range naming it; context =
 * the fact's text is in the request the host would send next; recall = rank of
 * its entry on page 1 of a reworded keel_recall query (- = not found).
 *
 * Then the same four, for each fact again 10, 30 and 60 turns after its own
 * (where the run reaches): how what keel keeps of a fact falls off with distance.
 */
import { runLongHorizon } from "../tests/support/long-horizon";
import { statsLine } from "../tests/support/host-session";

const hostArg = process.argv.find((a) => a.startsWith("--host="));
if (hostArg) process.env.KEEL_LH_HOST = hostArg.split("=")[1];
const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "keel";
const config = mode === "evict" ? { evict: true } : undefined;
const argv = process.argv.filter((a) => !a.startsWith("--host=") && !a.startsWith("--mode="));
const turns = Number(argv[2] ?? 60);
const every = Number(argv[3] ?? 6);
const windowArg = argv[4];
const windows: Array<number | undefined> = windowArg === "all" ? [32_768, 128_000, 1_000_000] : [windowArg ? Number(windowArg) : undefined];

for (const contextWindow of windows) for (const t of [turns, turns * 2]) {
  const r = await runLongHorizon({ turns: t, compactEvery: every, contextWindow, config });
  const label = contextWindow ? `, ${Math.round(contextWindow / 1000)}K window` : "";
  console.log(`\n${t} turns in ${r.host}, ${r.host === "pi" ? "Pi's /compact" : "omp's idle pass"} every ${every}${label}${mode === "evict" ? ", turns out whole" : ""} -> ${r.compactions} compactions (${r.byKeel} by keel); summary chars first/max/last: ${r.summaryChars[0] ?? 0}/${r.summaryChars.length ? Math.max(...r.summaryChars) : 0}/${r.summaryChars.at(-1) ?? 0}; ${statsLine(r.stats)}`);
  console.log("kind          turn  summary  pointer  context  recall");
  const yes = (b: boolean) => (b ? "yes" : "no").padEnd(7);
  for (const n of r.needles) {
    console.log(`${n.kind.padEnd(13)} ${String(n.turn).padStart(4)}  ${yes(n.inSummary)}  ${yes(n.pointed)}  ${yes(n.inContext)}  ${n.recallRank ?? "-"}`);
  }
  const k = r.needles.length;
  const count = (f: (n: (typeof r.needles)[number]) => boolean) => r.needles.filter(f).length;
  console.log(`totals: summary ${count((n) => n.inSummary)}/${k}, pointer ${count((n) => n.pointed)}/${k}, context ${count((n) => n.inContext)}/${k}, recall@5 ${count((n) => n.recallRank != null)}/${k}`);
  // How what keel keeps of a fact falls off with distance: each fact scored again N turns after its own.
  const delays = [...new Set(r.probes.map((p) => p.delay))].sort((a, b) => a - b);
  if (delays.length > 0) {
    console.log("delay  facts  summary  pointer  context  recall@5");
    for (const d of delays) {
      const at = r.probes.filter((p) => p.delay === d);
      const of = (f: (p: (typeof at)[number]) => boolean) => `${at.filter(f).length}/${at.length}`.padEnd(7);
      console.log(`${String(d).padStart(5)}  ${String(at.length).padStart(5)}  ${of((p) => p.inSummary)}  ${of((p) => p.pointed)}  ${of((p) => p.inContext)}  ${of((p) => p.recallRank != null)}`);
    }
  }
}
