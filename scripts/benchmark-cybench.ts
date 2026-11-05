/**
 * Cybench as one long session (tests/support/cybench.ts): a real model in omp
 * (or Pi) works through Cybench's file-only CTF tasks back to back, answering
 * each task's own subtask questions, then is asked again what it found tasks ago.
 *
 *   OMP_VCC_LH_API_KEY=… bun run scripts/benchmark-cybench.ts [tasks] [contextWindow] [vcc|vcc-no-ws|own] [--host=omp|pi] [--detach] [--max-requests=15]
 *
 * The model is DeepSeek V4.1 Flash unless OMP_VCC_LH_MODEL (in the env or research/long-horizon.env) names another.
 * The host is omp unless --host=pi (or OMP_VCC_LH_HOST=pi) runs it in Pi.
 *
 * tasks: how many of the 17 (default all); contextWindow: what the host is told
 * (default 128000); the compactor: omp-vcc (default), omp-vcc without
 * [Working Set], or the host's own compaction (`own`; `omp` still means it). Expect two to three hours for all
 * tasks; --detach runs it in a process of its own, logging to research/.
 * --max-requests caps the model requests one question may take (default 15,
 * Cybench's own iteration cap per subtask); past it the question is unanswered.
 *
 * Columns: answered right while working on the task; asked again at the end
 * (right / asked), and the tool calls it took to answer again (0 = from what the
 * context still held).
 */
import { spawn } from "child_process";
import { openSync } from "fs";
import { resolve } from "path";
import { CYBENCH_TASKS, runCybench } from "../tests/support/cybench";
import { LONG_HORIZON_MODEL, realModel, sessionHost } from "../tests/support/host-session";

const args = process.argv.slice(2).filter((a) => a !== "--detach" && !a.startsWith("--max-requests=") && !a.startsWith("--host="));
const capArg = process.argv.find((a) => a.startsWith("--max-requests="));
const hostArg = process.argv.find((a) => a.startsWith("--host="));
if (hostArg) process.env.OMP_VCC_LH_HOST = hostArg.split("=")[1];
const maxRequests = capArg ? Number(capArg.split("=")[1]) : undefined;
const tasks = args[0] && args[0] !== "all" ? Number(args[0]) : CYBENCH_TASKS.length;
const contextWindow = Number(args[1] ?? 128_000);
const mode = args[2] === "omp" ? "own" : args[2] ?? "vcc";
const model = realModel({ keyFile: true })?.model ?? LONG_HORIZON_MODEL.model;
// The key file may set OMP_VCC_LH_HOST too; read after it.
const host = sessionHost();
// Pi's logs go to files of their own; omp's keep their names (and `own` its old name, `omp`).
const hostTag = host === "pi" ? "pi-" : "";
const modeTag = mode === "own" && host === "omp" ? "omp" : mode;
// Another model's logs go to files of their own, so they never append to the default model's.
const modelTag = model === LONG_HORIZON_MODEL.model ? "" : `${model.split("/").pop()!.replace(/[^\w.-]+/g, "_")}-`;

// --detach: run in a process of its own, logging to research/, and return at once (a run takes hours).
if (process.argv.includes("--detach")) {
  const log = resolve(import.meta.dir, `../research/cybench-${hostTag}${modelTag}${modeTag}-${Math.round(contextWindow / 1000)}k-${tasks}.txt`);
  const fd = openSync(log, "a");
  const child = spawn(process.execPath, ["run", import.meta.path, ...args, ...(capArg ? [capArg] : []), `--host=${host}`], { detached: true, stdio: ["ignore", fd, fd], cwd: resolve(import.meta.dir, "..") });
  child.unref();
  console.log(`running in the background (pid ${child.pid}), logging to ${log}`);
  process.exit(0);
}
const config = mode === "own" ? { overrideDefaultCompaction: false } : mode === "vcc-no-ws" ? { workingSet: false } : {};

const started = Date.now();
const r = await runCybench({ host, tasks, contextWindow, config, maxRequests, log: (l) => console.log(`  ${l}`) });
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
console.log(`\n${tasks} tasks, ${Math.round(contextWindow / 1000)}K window, ${host}, ${model}, ${mode}: ${r.compactions} compactions (${r.byOmpVcc} by omp-vcc), ${r.requests} requests, ${Math.round(r.promptTokens / 1000)}K prompt tokens, ${minutes} min`);
console.log("task                                  answered  again  calls to answer again");
for (const [name, t] of byTask) console.log(`${name.slice(0, 36).padEnd(37)} ${`${t.right}/${t.total}`.padStart(8)}  ${t.asked ? `${t.again}/${t.asked}`.padStart(5) : "    -"}  ${t.asked ? t.calls : "-"}`);
const right = r.answers.filter((a) => a.correct).length;
const again = r.recall.filter((a) => a.correct).length;
const fromContext = r.recall.filter((a) => a.correct && a.toolCalls === 0).length;
console.log(`totals: answered ${right}/${r.answers.length}; asked again ${again}/${r.recall.length}, ${fromContext} of them with no tool call; ${r.recall.reduce((n, a) => n + a.toolCalls, 0)} tool calls to answer again`);
// omp leaves handles open after the session closes; the run is over, so don't sit on them for hours.
process.exit(0);
