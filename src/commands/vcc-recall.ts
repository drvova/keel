// /omp-vcc-recall (/pi-vcc-recall on Pi): recall typed by a person, the output
// sent to the agent as a message of its own.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { parseCommandRequest, type RecallScope } from "../core/recall-request";
import { recall, type RecallPagingHints } from "../core/recall-run";
import { tell, type Binding } from "../host";
import { RECALL_COMMAND_MESSAGE_TYPE } from "../names";

const scopeArg = (scope: RecallScope) => (scope === "all" ? " scope:all" : scope === "project" ? " scope:project" : "");

/** Follow-up hints as the command is typed; inside an earlier session they carry session:<id>. */
export const commandHints = (name: string) => (short?: string): RecallPagingHints => {
  const at = short ? ` session:${short}` : "";
  return {
    outOfRange: (query, scope, totalPages, truncated) =>
      `Use /${name} ${query}${at}${scopeArg(scope)} page:N with N between 1 and ${totalPages}` +
      (truncated ? "." : ", or refine your query."),
    nextPage: (query, scope, page) => `\n--- /${name} ${query}${at}${scopeArg(scope)} page:${page} ---`,
    // The command lists sessions; mode:'touched' is the tool's alone.
    listPage: (mode, page) => (mode === "sessions" ? `\n--- /${name} sessions page:${page} ---` : ""),
    otherSessions: (n) =>
      `This project has ${n} earlier session${n === 1 ? "" : "s"}: add scope:project to search ${n === 1 ? "it" : "them"} too; /${name} sessions lists ${n === 1 ? "it" : "them"}.`,
  };
};

export const registerVccRecallCommand = (pi: ExtensionAPI, host: Pick<Binding, "command" | "window">) => {
  const name = `${host.command}-recall`;
  pi.registerCommand(name, {
    description:
      "Recall earlier parts of this session. Plain keywords work best; scope:all reaches edited or retried turns, " +
      "scope:project this project's earlier sessions; 'sessions' lists them, session:<id> reads one.",
    handler: async (args: string, ctx) => {
      const result = recall(
        { request: parseCommandRequest(args), sessionManager: ctx.sessionManager, contextWindow: host.window(ctx.model).effective, call: { surface: "command", name, args } },
        commandHints(name),
      );
      if (!result.ok) {
        tell(ctx, result.text, result.severity);
        return;
      }
      pi.sendMessage({ customType: RECALL_COMMAND_MESSAGE_TYPE, content: result.text, display: true }, { triggerTurn: true });
    },
  });
};
