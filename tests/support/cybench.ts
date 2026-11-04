// Cybench (Zhang et al., ICLR 2025, arXiv:2408.08926; Apache-2.0) as one long
// session: a real model in omp, with omp-vcc loaded, works through Cybench's
// file-only capture-the-flag tasks back to back (binaries to reverse, a pcap and
// emails to dissect, crypto to break), answering each task's own subtask
// questions in Cybench's guided mode. The questions and answers are Cybench's,
// not ours. Then a late round asks again what was found tasks ago (each flag,
// and an earlier finding), to see what the compactions in between kept: whether
// the agent still knows it, and how many tool calls it takes to get it back.
//
// The tasks are fetched from Cybench's repository at a pinned commit into
// research/cybench (git-ignored); each task's files are copied out as its own
// init script would copy them, without running it, and the agent never sees a
// task's metadata, solution or flag file. omp runs everything: the agent
// loop, the tools, the context counting, every compaction (tests/support/omp-session.ts).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { openOmpSession, textOf } from "./omp-session";

export const CYBENCH_REPO = "https://github.com/andyzorigin/cybench.git";
export const CYBENCH_COMMIT = "ca483c6443f17a20ba7d6bac3d274859a1721e51";
const CACHE = resolve(import.meta.dir, "../../research/cybench");

/**
 * The tasks that need only their files (no server, no Docker), easiest first, and
 * the files each hands the agent: what the task's own init_script.sh copies, taken
 * here without running it. Never metadata/, solution/ or a flag file.
 */
interface TaskSpec {
  path: string;
  /** Files or directories copied from the task's directory, by their name in it. */
  copy?: string[];
  /** A zip in the task's directory, and the entries of it the agent gets (all when omitted). */
  unzip?: { zip: string; take?: string[] };
}
export const CYBENCH_TASKS: TaskSpec[] = [
  { path: "hackthebox/cyber-apocalypse-2024/reversing/[Very Easy] LootStash", unzip: { zip: "release/rev_lootstash.zip", take: ["rev_lootstash/stash"] } },
  { path: "hackthebox/cyber-apocalypse-2024/forensics/[Very Easy] Urgent", copy: ["release/forensics_urgent.zip"] },
  { path: "hackthebox/cyber-apocalypse-2024/crypto/[Very Easy] Dynastic", copy: ["challenge/output.txt", "challenge/source.py"] },
  { path: "hackthebox/cyber-apocalypse-2024/reversing/[Very Easy] PackedAway", unzip: { zip: "release/rev_packedaway.zip", take: ["rev_packedaway/packed"] } },
  { path: "hackthebox/cyber-apocalypse-2024/forensics/[Very Easy] It Has Begun", unzip: { zip: "release/forensics_it_has_begun.zip" } },
  { path: "hackthebox/cyber-apocalypse-2024/crypto/[Very Easy] Makeshift", copy: ["challenge/output.txt", "challenge/source.py"] },
  { path: "hackthebox/cyber-apocalypse-2024/reversing/[Very Easy] BoxCutter", unzip: { zip: "release/rev_boxcutter.zip", take: ["rev_boxcutter/cutter"] } },
  { path: "hackthebox/cyber-apocalypse-2024/crypto/[Very Easy] Primary Knowledge", copy: ["challenge/output.txt", "challenge/source.py"] },
  { path: "hackthebox/cyber-apocalypse-2024/reversing/[Easy] Crushing", unzip: { zip: "release/rev_crushing.zip", take: ["rev_crushing/crush", "rev_crushing/message.txt.cz"] } },
  { path: "hackthebox/cyber-apocalypse-2024/hw/Maze [Very Easy]", copy: ["challenge/fs"] },
  { path: "hackthebox/cyber-apocalypse-2024/crypto/[Medium] Partial Tenacity", copy: ["challenge/output.txt", "challenge/source.py"] },
  { path: "hackthebox/cyber-apocalypse-2024/forensics/[Medium] Data Siege", copy: ["capture.pcap"] },
  { path: "project-sekai-ctf/sekaictf-2022/reverse/matrix-lab-2", copy: ["challenge/Matrix_Lab_2.exe", "challenge/pyinstxtractor.py"] },
  { path: "project-sekai-ctf/sekaictf-2023/reverse/guardians-of-the-kernel", copy: ["dist/initramfs.cpio.gz", "dist/bzImage"] },
  { path: "project-sekai-ctf/sekaictf-2022/crypto/diffecient", copy: ["challenge/app/diffecient.py"] },
  { path: "hackthebox/cyber-apocalypse-2024/crypto/[Hard] Permuted", copy: ["challenge/output.txt", "challenge/source.py"] },
  { path: "hackthebox/cyber-apocalypse-2024/reversing/[Hard] FlecksOfGold", copy: ["release/rev_flecksofgold/flecks"] },
];

interface Subtask { question: string; answer: string; answer_format?: string }
interface Task { spec: TaskSpec; path: string; name: string; dir: string; prompt: string; subtasks: Subtask[]; difficulty: number }

export interface CybenchOptions {
  /** How many of CYBENCH_TASKS to run, from the start (default all). */
  tasks?: number;
  /** The window omp is told (default 128K). */
  contextWindow?: number;
  /** omp-vcc settings: `{ workingSet: false }`, or `{ overrideDefaultCompaction: false }` for omp's own compaction. */
  config?: Record<string, unknown>;
  /** Ask again, at the end, what was found in earlier tasks (default true). */
  lateRecall?: boolean;
  /** Progress lines, one per answer. */
  log?: (line: string) => void;
}

export interface AnswerScore {
  task: string;
  question: string;
  expected: string;
  given: string | null;
  correct: boolean;
  /** Tool calls the agent made for this answer. */
  toolCalls: number;
}

export interface CybenchResult {
  answers: AnswerScore[];
  /** The late round: a question asked again, tasks after it was answered right. */
  recall: AnswerScore[];
  compactions: number;
  byOmpVcc: number;
  requests: number;
  promptTokens: number;
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

/** Cybench's repository at the pinned commit, only the tasks' directories (research/cybench). */
export const fetchCybench = (dir = CACHE): string => {
  const marker = join(dir, ".omp-vcc-commit");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === CYBENCH_COMMIT) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", CYBENCH_REPO);
  git(dir, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", CYBENCH_COMMIT);
  git(dir, "sparse-checkout", "init", "--no-cone");
  // Sparse patterns are gitignore globs: brackets in the task names are literal.
  const patterns = ["/LICENSE", ...CYBENCH_TASKS.map((t) => `/benchmark/${t.path.replace(/[[\]]/g, (c) => `\\${c}`)}/`)].join("\n");
  writeFileSync(join(dir, ".git", "info", "sparse-checkout"), patterns + "\n");
  git(dir, "checkout", "-q", CYBENCH_COMMIT);
  writeFileSync(marker, CYBENCH_COMMIT + "\n");
  return dir;
};

const slug = (path: string, i: number) => `${String(i + 1).padStart(2, "0")}-${path.split("/").at(-1)!.replace(/\[[^\]]*\]/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

const loadTask = (root: string, spec: TaskSpec, i: number): Task => {
  const path = spec.path;
  const meta = JSON.parse(readFileSync(join(root, "benchmark", path, "metadata", "metadata.json"), "utf8"));
  return {
    spec,
    path,
    name: path.split("/").at(-1)!,
    dir: slug(path, i),
    prompt: String(meta.hard_prompt ?? meta.easy_prompt ?? "").trim(),
    subtasks: meta.subtasks.map((s: any) => ({ question: String(s.question), answer: String(s.answer), answer_format: s.answer_format })),
    difficulty: Number(meta.difficulty ?? 0),
  };
};

/** The task's files in `into`, flat, as its init script would leave them; nothing of the task is run. */
const setUpTask = (root: string, task: Task, into: string, scratch: string) => {
  const from = join(root, "benchmark", task.path);
  mkdirSync(into, { recursive: true });
  for (const name of task.spec.copy ?? []) {
    if (!existsSync(join(from, name))) throw new Error(`${task.name}: no ${name}`);
    cpSync(join(from, name), join(into, basename(name)), { recursive: true });
  }
  if (task.spec.unzip) {
    const out = mkdtempSync(join(scratch, "unzip-"));
    const r = Bun.spawnSync(["unzip", "-q", "-o", join(from, task.spec.unzip.zip), "-d", out], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${task.name}: unzip ${task.spec.unzip.zip}: ${r.stderr.toString().slice(0, 300)}`);
    const take = task.spec.unzip.take ?? readdirSync(out);
    for (const name of take) cpSync(join(out, name), join(into, basename(name)), { recursive: true });
    rmSync(out, { recursive: true, force: true });
  }
};

/** Cybench compares answers case-insensitively, as written; quotes and code marks around them do not count. */
const normalize = (s: string) => s.trim().replace(/^[`'"*]+|[`'"*.]+$/g, "").trim().toLowerCase();

const lastAnswer = (text: string): string | null => {
  const m = [...text.matchAll(/^\s*\**answer\**\s*:\s*(.+?)\s*$/gim)].at(-1);
  return m ? m[1] : null;
};

/** The agent's final reply for the latest request, and the tool calls it made since that request. */
const lastTurn = (sessionManager: any): { reply: string; toolCalls: number } => {
  const branch = sessionManager.getBranch().filter((e: any) => e.type === "message");
  let i = branch.length - 1;
  while (i >= 0 && branch[i].message.role !== "user") i--;
  const turn = branch.slice(i + 1).map((e: any) => e.message);
  const toolCalls = turn.filter((m: any) => m.role === "assistant").reduce((n: number, m: any) => n + (Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === "toolCall").length : 0), 0);
  const reply = [...turn].reverse().find((m: any) => m.role === "assistant" && textOf(m).trim());
  return { reply: reply ? textOf(reply) : "", toolCalls };
};

export const runCybench = async (options: CybenchOptions = {}): Promise<CybenchResult> => {
  const root = fetchCybench();
  const tasks = CYBENCH_TASKS.slice(0, options.tasks ?? CYBENCH_TASKS.length).map((p, i) => loadTask(root, p, i));
  const work = mkdtempSync(join(tmpdir(), "omp-vcc-cybench-"));
  let omp: Awaited<ReturnType<typeof openOmpSession>> | undefined;
  try {
    const proj = join(work, "ctf");
    for (const task of tasks) setUpTask(root, task, join(proj, task.dir), work);
    omp = await openOmpSession({ work, cwd: proj, contextWindow: options.contextWindow, config: options.config });
    const { session, sessionManager } = omp;
    const ask = async (task: Task, text: string, subtask: Subtask): Promise<AnswerScore> => {
      await session.prompt(text);
      const { reply, toolCalls } = lastTurn(sessionManager);
      const given = lastAnswer(reply);
      const score = { task: task.name, question: subtask.question, expected: subtask.answer, given, correct: given !== null && normalize(given) === normalize(subtask.answer), toolCalls };
      options.log?.(`${score.correct ? "ok " : "-- "} ${task.name}: ${subtask.question.slice(0, 70)} -> ${given ?? "(no answer)"} (${toolCalls} calls)`);
      return score;
    };

    const answers: AnswerScore[] = [];
    for (const [i, task] of tasks.entries()) {
      for (const [k, subtask] of task.subtasks.entries()) {
        const head = k === 0
          ? `Challenge ${i + 1}: its files are in ./${task.dir}/ (work there). ${task.prompt}\n\nI will ask you questions about it one at a time. End each reply with a line "Answer: <your answer>".\n\n`
          : "";
        const format = subtask.answer_format ? ` (answer format: ${subtask.answer_format})` : "";
        answers.push(await ask(task, `${head}Challenge ${i + 1}, question ${k + 1} of ${task.subtasks.length}: ${subtask.question}${format}`, subtask));
      }
    }

    // What was found tasks ago, asked again: each task's last answer (its flag) and its first, where they were right.
    const recall: AnswerScore[] = [];
    if (options.lateRecall !== false) {
      for (const [i, task] of tasks.entries()) {
        const picks = [...new Set([task.subtasks.length - 1, 0])];
        for (const k of picks) {
          const subtask = task.subtasks[k];
          const before = answers.find((a) => a.task === task.name && a.question === subtask.question);
          if (!before?.correct) continue;
          const format = subtask.answer_format ? ` (answer format: ${subtask.answer_format})` : "";
          recall.push(await ask(task, `Back to challenge ${i + 1} (./${task.dir}/), which you worked on earlier: ${subtask.question}${format} Answer from what you found then. End with a line "Answer: <your answer>".`, subtask));
        }
      }
    }

    await sessionManager.flush?.();
    const branch = sessionManager.getBranch();
    const compactions = branch.filter((e: any) => e.type === "compaction");
    const assistants = branch.filter((e: any) => e.type === "message" && e.message.role === "assistant" && e.message.usage);
    return {
      answers,
      recall,
      compactions: compactions.length,
      byOmpVcc: compactions.filter((e: any) => e.details?.compactor === "omp-vcc").length,
      requests: assistants.length,
      promptTokens: assistants.reduce((n: number, e: any) => n + (e.message.usage.input ?? 0) + (e.message.usage.cacheRead ?? 0), 0),
    };
  } finally {
    await omp?.close();
    rmSync(work, { recursive: true, force: true });
  }
};
