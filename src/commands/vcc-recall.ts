import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { parseCommandRequest } from "../core/recall-request";
import {
  openRecallView,
  openSessionView,
  projectSessions,
  recallOutputChars,
  runRecall,
  sessionHeader,
  type RecallPagingHints,
} from "../core/recall-run";
import { resolveSession } from "../core/sessions";
import { sessionDirOf } from "../tools/recall";
import { tell } from "./compact-feedback";

const scopeArg = (scope: string) => (scope === "all" ? " scope:all" : scope === "project" ? " scope:project" : "");

const commandHints = (session?: string): RecallPagingHints => {
  const at = session ? ` session:${session}` : "";
  return {
    outOfRange: (query, scope, totalPages, truncated) =>
      `Use /omp-vcc-recall ${query}${at}${scopeArg(scope)} page:N with N between 1 and ${totalPages}` +
      (truncated ? "." : ", or refine your query."),
    nextPage: (query, scope, page) => `\n--- /omp-vcc-recall ${query}${at}${scopeArg(scope)} page:${page} ---`,
    otherSessions: (n) =>
      `This project has ${n} earlier session${n === 1 ? "" : "s"}: add scope:project to search ${n === 1 ? "it" : "them"} too; /omp-vcc-recall sessions lists ${n === 1 ? "it" : "them"}.`,
  };
};

export const registerVccRecallCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("omp-vcc-recall", {
    description:
      "Recall earlier parts of this session. Plain keywords work best; scope:all reaches edited or retried turns, " +
      "scope:project this project's earlier sessions; 'sessions' lists them, session:<id> reads one.",
    handler: async (args: string, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        tell(ctx, "No session file available.", "error");
        return;
      }
      const request = parseCommandRequest(args);
      const project = projectSessions(sessionDirOf(ctx.sessionManager as any, sessionFile), sessionFile);
      const maxChars = recallOutputChars((ctx as any).model?.contextWindow);
      let content: string;
      if (request.session) {
        const target = resolveSession(request.session, project.list());
        if ("error" in target) {
          tell(ctx, target.error, "warning");
          return;
        }
        content = runRecall(request, openSessionView(target, request.scope, project), commandHints(target.short), {
          maxChars: Math.max(0, maxChars - 300),
          header: sessionHeader(target),
        });
      } else {
        content = runRecall(request, openRecallView(sessionFile, request.scope, ctx.sessionManager, { project }), commandHints(), { maxChars });
      }
      pi.sendMessage({ customType: "vcc-recall", content, display: true }, { triggerTurn: true });
    },
  });
};
