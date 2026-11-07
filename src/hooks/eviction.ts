// Before every request, with the evict setting on: the turns that are out of
// the context leave the request, a line stands in their place, and past 85% of
// the host's trigger the oldest finished turns leave by themselves
// (src/core/evict.ts, lisp/src/evict.lisp). Only the request changes; the
// session file keeps every word.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { tell, type Binding } from "../host";
import { whenCore } from "../core/core-wait";
import { evictRequest } from "../core/evict";

export const registerEviction = (pi: ExtensionAPI, host: Pick<Binding, "name" | "displayName" | "modelsFile" | "config">): void => {
  pi.on("context", (event, ctx) =>
    whenCore(() => {
      if (!host.config.load().evict) return undefined;
      const { messages, notice } = evictRequest({ appendEntry: (type, data) => pi.appendEntry(type, data) }, host, ctx as any, event.messages as unknown[]);
      if (notice) tell(ctx as any, notice, "info");
      return messages ? { messages: messages as typeof event.messages } : undefined;
    }));
};
