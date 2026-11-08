// Install the hosts into node_modules without saving them, each at a version
// named by an environment variable (default: latest).
//
//   bun run setup:hosts                     both hosts, at their newest
//   OMP_VERSION=18.14.0 bun run setup:hosts omp pinned, Pi at its newest
//   bun run setup:omp                       the same, naming one host
//
// omp and Pi are not dependencies: they release often, and a pinned copy would
// test a version users have long updated past. CI installs each at its floor
// and at its latest, from the peer ranges in package.json.
//
// Why npm, from an empty node_modules, both hosts in one call:
// - npm reconciles the tree against package.json and neither host is in it, so
//   any install that starts from an existing tree prunes both. Starting empty
//   makes every run produce the same tree: package.json's dependencies plus
//   both hosts.
// - `bun add --no-save` was tried first and cannot pin: it treats an installed
//   package as satisfying a requested version (a floor pin silently stayed at
//   the newest), and on an empty tree it installs the hosts without their
//   dependencies.
//
// A script rather than the `npm install …@${VERSION:-latest}` line this
// replaced: that expansion is the shell's, and Windows runs a package script
// through cmd, which does not do it.
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
