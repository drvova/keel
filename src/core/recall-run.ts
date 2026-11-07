// One recall call, for the tool and the command alike, run by the Lisp core
// (op recall, lisp/src/request.lisp and recall.lisp): the params or text
// parsed, the session or the earlier one it names read, the action run, the
// output capped. What only the host knows comes from here: the session file,
// the project's other files newest first, the path the session manager is on.
import { currentBranchIds, hostBranch, type SessionManagerLike } from "./session-file";
import { projectFiles, sessionDirOf } from "./sessions";
import { core } from "./lisp-core";

export interface RecallInput {
  sessionManager: SessionManagerLike & { getSessionDir?(): string | undefined };
  /** The model's window: it scales the output cap. */
  contextWindow?: number;
  /**
   * Leave the current turn (last user message on the path and everything after
   * it) out of search: the agent has it in context, and its question would
   * otherwise match itself. Only the tool sets this; a /omp-vcc-recall command
   * adds no user message, so the last one there belongs to a finished turn.
   */
  skipCurrentTurn?: boolean;
  /** The call as it came: the tool's params or the command's text. */
  call: { surface: "tool"; params: unknown } | { surface: "command"; name: string; args: string };
}

export type RecallResult = { ok: true; text: string } | { ok: false; text: string; severity: "error" | "warning" };

/** One recall call; `ok: false` when there is nothing to read, with how bad that is for a person told so. */
export const recall = (input: RecallInput): RecallResult => {
  const { sessionManager } = input;
  const sessionFile = sessionManager.getSessionFile?.();
  const dir = sessionFile ? sessionDirOf(sessionManager, sessionFile) : undefined;
  const reply = core({
    op: "recall",
    input: {
      call: input.call,
      sessionFile,
      // Listing a directory by modification time is the host's (to the millisecond; SBCL reads seconds).
      projectFiles: dir && sessionFile ? projectFiles(dir, sessionFile) : [],
      cwd: process.cwd(),
      lineageIds: [...currentBranchIds(sessionManager)],
      hostBranch: (hostBranch(sessionManager) ?? []).map((e: any) => ({ type: e?.type, role: e?.message?.role })),
      contextWindow: input.contextWindow,
      skipCurrentTurn: input.skipCurrentTurn === true,
    },
  });
  const r = reply.recall as { ok: boolean; text: string; severity?: "error" | "warning" };
  return r.ok ? { ok: true, text: r.text } : { ok: false, text: r.text, severity: r.severity ?? "error" };
};
