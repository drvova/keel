import { mkdir, mkdtemp, copyFile, chmod, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

/** Where each host keeps its session files. */
export const sessionRoot = (host: "omp" | "pi"): string =>
  join(process.env.HOME ?? "", host === "pi" ? ".pi/agent/sessions" : ".omp/agent/sessions");

export interface SessionSample {
  source: string;
  copy: string;
  size: number;
  mtimeMs: number;
}

const walk = async (dir: string): Promise<string[]> => {
  const names = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...await walk(path));
    else if (name.isFile() && path.endsWith(".jsonl")) out.push(path);
  }
  return out;
};

const pickLargest = async (limit: number, root: string): Promise<string[]> => {
  // A host with no sessions here has none to sample.
  const files = await walk(root).catch(() => [] as string[]);
  const sized = await Promise.all(
    files.map(async (file) => ({ file, size: (await stat(file)).size })),
  );
  return sized.sort((a, b) => b.size - a.size).slice(0, limit).map((x) => x.file);
};

export const prepareSessionSamples = async (limit = 2, host: "omp" | "pi" = "omp"): Promise<SessionSample[]> => {
  const selected = await pickLargest(limit, sessionRoot(host));
  const dir = await mkdtemp(join(tmpdir(), "keel-sessions-"));
  await mkdir(dir, { recursive: true });
  const samples: SessionSample[] = [];
  for (const source of selected) {
    const srcStat = await stat(source);
    const copy = join(dir, basename(source));
    await copyFile(source, copy);
    await chmod(copy, 0o444);
    samples.push({ source, copy, size: srcStat.size, mtimeMs: srcStat.mtimeMs });
  }
  return samples;
};
