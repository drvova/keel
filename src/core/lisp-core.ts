import { spawnSync } from "node:child_process";

/**
 * The Lisp core (lisp/): one JSON request on its stdin, one response on its
 * stdout, then it exits (lisp/src/server.lisp). spawnSync keeps the callers
 * synchronous; a start costs ~5 ms.
 *
 * It is found through OMP_VCC_CORE, the executable's path, while the port is
 * under way. Every failure (no core, a crash, a refusal, a reply that does not
 * parse) is undefined, and the caller runs the TypeScript code instead: a
 * broken core costs speed, never an answer.
 */
export const callCore = (request: object): Record<string, unknown> | undefined => {
  const core = process.env.OMP_VCC_CORE;
  if (!core) return undefined;
  const run = spawnSync(core, [], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 30 });
  if (run.error || run.status !== 0) return undefined;
  try {
    const reply = JSON.parse(run.stdout);
    return reply && typeof reply === "object" && reply.ok === true ? reply : undefined;
  } catch {
    return undefined;
  }
};
