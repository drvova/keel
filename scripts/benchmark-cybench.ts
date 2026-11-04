/**
 * Cybench as one long session (tests/support/cybench.ts): a real model in omp
 * works through Cybench's file-only CTF tasks back to back, answering each task's
 * own subtask questions, then is asked again what it found tasks ago.
 *
 *   OMP_VCC_LH_API_KEY=… bun run scripts/benchmark-cybench.ts [tasks] [contextWindow] [vcc|vcc-no-ws|omp]
 *
 * tasks: how many of the 17 (default all); contextWindow: what omp is told
 * (default 128000); the compactor: omp-vcc (default), omp-vcc without
 * [Working Set], or omp's own compaction. Expect an hour or more for all tasks.
 *
 * Columns: answered right while working on the task; asked again at the end
 * (right / asked), and the tool calls it took to answer again (0 = from what the
 * context still held).
 */
import { CYBENCH_TASKS, runCybench } from "../tests/support/cybench";

const tasks = process.argv[2] && process.argv[2] !== "all" ? Number(process.argv[2]) : CYBENCH_TASKS.length;
const contextWindow = Number(process.argv[3] ?? 128_000);
const mode = process.argv[4] ?? "vcc";
const config = mode === "omp" ? { overrideDefaultCompaction: false } : mode === "vcc-no-ws" ? { workingSet: false } : {};

const started = Date.now();
const r = await runCybench({ tasks, contextWindow, config, log: (l) => console.log(`  ${l}`) });
const minutes = Math.round((Date.now() - started) / 60_000);

const byTask = new Map<string, { right: number; total: number; again: number; asked: number; calls: number }>();
for (const a of r.answers) {
  const t = byTask.get(a.task) ?? { right: 0, total: 0, again: 0, asked: 0, calls: 0 };
  t.total++;
  if (a.correct) t.right++;
  byTask.set(a.task, t);
}
for (const a of r.recall) {
  const t = byTask.get(a.task)!;
  t.asked++;
  if (a.correct) t.again++;
  t.calls += a.toolCalls;
}
console.log(`\n${tasks} tasks, ${Math.round(contextWindow / 1000)}K window, ${mode}: ${r.compactions} compactions (${r.byOmpVcc} by omp-vcc), ${r.requests} requests, ${Math.round(r.promptTokens / 1000)}K prompt tokens, ${minutes} min`);
console.log("task                                  answered  again  calls to answer again");
for (const [name, t] of byTask) console.log(`${name.slice(0, 36).padEnd(37)} ${`${t.right}/${t.total}`.padStart(8)}  ${t.asked ? `${t.again}/${t.asked}`.padStart(5) : "    -"}  ${t.asked ? t.calls : "-"}`);
const right = r.answers.filter((a) => a.correct).length;
const again = r.recall.filter((a) => a.correct).length;
const fromContext = r.recall.filter((a) => a.correct && a.toolCalls === 0).length;
console.log(`totals: answered ${right}/${r.answers.length}; asked again ${again}/${r.recall.length}, ${fromContext} of them with no tool call; ${r.recall.reduce((n, a) => n + a.toolCalls, 0)} tool calls to answer again`);
