// Install the hosts into node_modules without saving them, each at a version
// named by an environment variable (default: latest).
//
//   bun run setup:omp                       omp at its newest
//   OMP_VERSION=18.14.0 bun run setup:omp   omp at a version of its own
//
// omp and Pi are not dependencies: they release often, and a pinned copy would
// test a version users have long updated past. CI installs each at its floor
// and at its latest, from the peer ranges in package.json.
//
// Both hosts go in one npm call, from an empty node_modules. npm reconciles
// the tree against package.json on every run and neither host is in it, so any
// install that starts from an existing tree prunes what is there — installing
// one host at a time, or rerunning on top of a good tree, deletes both. Starting
// empty makes the result the same on every run: package.json's dependencies
// plus both hosts, at the versions asked for.
//
// A script rather than an `npm install …@${VERSION:-latest}` line, whose shell
// expansion does not happen on Windows, where npm runs a script through cmd.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

/** The hosts, with the variable that names each one's version. */
const HOSTS = [
  { name: "@oh-my-pi/pi-coding-agent", variable: "OMP_VERSION", short: "omp" },
  { name: "@earendil-works/pi-coding-agent", variable: "PI_VERSION", short: "pi" },
] as const;

const named = process.argv[2];
if (named && !HOSTS.some((h) => h.short === named)) {
  console.error(`setup-host: name a host (${HOSTS.map((h) => h.short).join(", ")}), or none for both`);
  process.exit(1);
}

const root = join(import.meta.dir, "..");
rmSync(join(root, "node_modules"), { recursive: true, force: true });

const args = ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund",
  ...HOSTS.map((h) => `${h.name}@${process.env[h.variable]?.trim() || "latest"}`)];
// npm is a shell wrapper on Windows too (a .cmd), which no runtime spawns
// without one; git-bash's sh is what npm expects there.
const run = spawnSync(
  process.platform === "win32" ? "sh" : "npm",
  process.platform === "win32" ? ["-c", `npm ${args.map((a) => `"${a}"`).join(" ")}`] : args,
  { cwd: root, stdio: "inherit" },
);
process.exit(run.status ?? 1);
