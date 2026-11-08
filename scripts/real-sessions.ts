/**
 * keel's summary of the largest real sessions on this machine (~/.omp or
 * ~/.pi), read from copies so a session the host is writing to stays as it is:
 *
 *   bun run scripts/real-sessions.ts [report|show|save NAME] [--host=omp|pi] [--count=N]
 *
 * report (default): per session, its size, how long the summary took, and the
 * compression and recall numbers (tests/support/report.ts), as JSON.
 * show: each session's entries as recall renders them, then the summary.
 * save NAME: each summary to /tmp/keel-compare/NAME/, to diff two branches' output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { compile } from "../tests/support/compile";
import { loadPiSessionMessages, loadSessionMessages } from "../tests/support/load-session";
import { renderedOf } from "../tests/support/pairs";
import { prepareSessionSamples, sessionRoot } from "../tests/support/real-sessions";
import { buildCompactReport } from "../tests/support/report";
import { DEFAULT_SUMMARY_LIMITS } from "../tests/support/window";

const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const [mode = "report", name] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const host = flag("host") === "pi" ? "pi" : "omp";
const samples = await prepareSessionSamples(Number(flag("count") ?? (mode === "save" ? 5 : 2)), host);
if (samples.length === 0) {
  console.log(`No ${host} sessions in ${sessionRoot(host)}.`);
  process.exit(0);
}
if (mode === "save" && !name) throw new Error("save takes a name: bun run scripts/real-sessions.ts save <name>");

for (const sample of samples) {
  // Each host's own parser and context builder (Pi's migrations and context edits applied).
  const loaded = host === "pi" ? await loadPiSessionMessages(sample.copy) : loadSessionMessages(sample.copy);
  const file = basename(sample.source);
  if (mode === "report") {
    const start = performance.now();
    const report = buildCompactReport({ messages: loaded.messages });
    console.log(JSON.stringify({
      sourceFile: file, sourceSizeBytes: sample.size, loadedMessages: loaded.messageCount, skippedMessages: loaded.skippedCount,
      compileMs: Number((performance.now() - start).toFixed(2)), before: report.before, after: report.after, compression: report.compression, recall: report.recall,
    }, null, 2));
    continue;
  }
  const summary = compile({ messages: loaded.messages, limits: DEFAULT_SUMMARY_LIMITS });
  if (mode === "save") {
    const dir = join("/tmp/keel-compare", name!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${file.slice(0, 30)}.txt`), summary);
    console.log(`${file.slice(0, 30)} (${loaded.messageCount} msgs) => ${summary.length} chars, in ${dir}/`);
    continue;
  }
  const before = renderedOf(loaded.messages).map((e) => `#${e.index} [${e.role}] ${e.summary.slice(0, 300)}`);
  const rule = "=".repeat(80);
  console.log(`${rule}\nFILE: ${file}\nMessages: ${loaded.messages.length} | Before chars: ${before.join("\n").length} | After chars: ${summary.length}\n${rule}`);
  console.log("\n--- BEFORE (first 40 and last 20 entries) ---\n");
  console.log([...before.slice(0, 40), ...(before.length > 60 ? [`\n... (${before.length - 60} entries omitted) ...\n`] : []), ...before.slice(Math.max(40, before.length - 20))].join("\n"));
  console.log(`\n--- AFTER (keel's summary) ---\n\n${summary}\n`);
}
