// /keel-recall (also /omp-vcc-recall on omp, /pi-vcc-recall on Pi): recall typed by a person, the output
// sent to the agent as a message of its own.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { whenCore } from "../core/core-wait";
import { recall } from "../core/recall-run";
import { deliver, registerCommand, tell, type Binding } from "../host";
import { RECALL_COMMAND_MESSAGE_TYPE } from "../names";

export const registerKeelRecallCommand = (pi: ExtensionAPI, host: Binding) => {
  const name = `${host.command}-recall`;
  registerCommand(pi, host, "recall", {
    description:
      "Recall earlier parts of this session. Plain keywords work best; scope:all reaches edited or retried turns, " +
      "scope:project this project's earlier sessions; 'sessions' lists them, session:<id> reads one.",
    handler: async (args: string, ctx) => {
      const result = whenCore(
        () => recall(host, ctx, { surface: "command", name, args }),
        (why) => tell(ctx, why, "warning"),
      );
      if (!result) return;
      if (!result.ok) {
        tell(ctx, result.text, result.severity);
        return;
      }
      await deliver(ctx, "the recall result", () => pi.sendMessage({ customType: RECALL_COMMAND_MESSAGE_TYPE, content: result.text, display: true }, { triggerTurn: true }));
    },
  });
};
