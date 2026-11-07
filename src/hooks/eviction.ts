// Before every request: the turns that are out of the context (by the agent,
// the user's evict command, or keel) leave the request, a line stands in
// their place, and with the evict setting on (the default), past 85% of the host's trigger,
// the oldest finished turns leave by themselves (src/core/evict.ts,
// lisp/src/evict.lisp). Only the request changes; the session file keeps every
// word. The core decides all of it; the hook only spares a request the call
// when there is nothing it could do: the setting off and no eviction recorded.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { deliver, tell, type Binding } from "../host";
import { whenCore } from "../core/core-wait";
import { evictRequest } from "../core/evict";
import { BUDGET_NOTICE_TYPE, isEvictEntryType } from "../names";
import { hostBranch } from "../core/session-file";

export const registerEviction = (pi: ExtensionAPI, host: Pick<Binding, "name" | "displayName" | "modelsFile" | "config">, tool: { registered: boolean }): void => {
  pi.on("context", (event, ctx) =>
    whenCore(() => {
      const recorded = hostBranch((ctx as any)?.sessionManager)?.some((e: any) => e?.type === "custom" && isEvictEntryType(e.customType));
      if (!recorded && !host.config.load().evict) return undefined;
      const { messages, note, notice } = evictRequest({ appendEntry: (type, data) => pi.appendEntry(type, data) }, host, ctx as any, event.messages as unknown[], tool.registered);
      if (notice) tell(ctx as any, notice, "info");
      // A message of its own, stored in the session, before the next model call: the provider's cache keeps it.
      if (note) void deliver(ctx as any, "the context's size to the agent", () => pi.sendMessage({ customType: BUDGET_NOTICE_TYPE, content: note, display: false }, { deliverAs: "nextTurn" }));
      return messages ? { messages: messages as typeof event.messages } : undefined;
    }));
};
