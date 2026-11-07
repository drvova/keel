// One recall call, for the tool and the command alike, run by the core (op
// recall, lisp/src/request.lisp and recall.lisp): the params or text parsed,
// the session or the earlier one it names read, the action run, the output
// capped to the model's window. What only the host knows comes in the
// snapshot, and the project's other files newest first, which only the host
// can order to the millisecond.
import { projectFiles, sessionDirOf } from "./sessions";
import { core } from "./lisp-core";
import { hostSnapshot, type HostCtx } from "./host-snapshot";

/** The call as it came: the tool's params or the command's text. */
export type RecallCall = { surface: "tool"; params: unknown } | { surface: "command"; name: string; args: string };

export type RecallResult = { ok: true; text: string } | { ok: false; text: string; severity: "error" | "warning" };

/** One recall call; `ok: false` when there is nothing to read, with how bad that is for a person told so. */
export const recall = (host: Parameters<typeof hostSnapshot>[0], ctx: HostCtx & { sessionManager?: { getSessionDir?(): string | undefined } }, call: RecallCall): RecallResult => {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const dir = sessionFile ? sessionDirOf(ctx.sessionManager!, sessionFile) : undefined;
  const r = core({ op: "recall", host: hostSnapshot(host, ctx), call, projectFiles: dir && sessionFile ? projectFiles(dir, sessionFile) : [] })
    .recall as { ok: boolean; text: string; severity: "error" | "warning" };
  return r.ok ? { ok: true, text: r.text } : { ok: false, text: r.text, severity: r.severity };
};
