// Everything keel registers on a host, the same on omp and on Pi: the tools
// and commands the core defines (src/surface.ts), each call handed to the core
// with the host's snapshot and its answer acted on (src/host.ts act), and the
// host's events likewise. Compaction keeps state across events
// (src/compaction.ts), as does keeping omp's originals (src/raw-capture.ts).
// Each binding gets its own state: omp binds the factory again for every
// subagent session while module state is shared.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { core, coreStatus, whenCore } from "./core";
import { act, hostBranch, hostSnapshot, projectFiles, registerCommand, tell, type Binding, type Host, type HostCtx, type NotifyCtx } from "./host";
import { openConfig } from "./settings";
import { createCompactionState, registerCompaction } from "./compaction";
import { registerRawCapture } from "./raw-capture";
import { SURFACE } from "./surface";

export const register = (pi: ExtensionAPI, host: Host): void => {
  // The core is built with the user's SBCL the first time this copy runs (src/core.ts): start it now.
  coreStatus();
  const binding: Binding = { ...host, config: openConfig(host.agentDir) };
  binding.config.scaffold();
  /** One op for this event, with what the host knows now. */
  const ask = (ctx: unknown, request: Record<string, unknown>) => core({ ...request, host: hostSnapshot(binding, ctx as HostCtx) });

  registerCompaction(pi, binding, createCompactionState());
  if (binding.rewritesInPlace) registerRawCapture(pi, binding);

  // keel_context comes with the evict setting; it is read through the core, which may not be built
  // yet: then the tool comes with the next session.
  const evictOn = whenCore(() => binding.config.load().evict) === true;
  for (const tool of SURFACE.tools) {
    if ("when" in tool && tool.when === "evict" && !evictOn) continue;
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as any,
      loadMode: "essential",
      // keel's tools read the session and write only keel's own entries, never the workspace.
      approval: "read",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        let text = "";
        const reply = whenCore(() => ask(ctx, { op: "tool", name: tool.name, params: params ?? null, projectFiles: projectFiles(ctx as HostCtx) }), (why) => { text = why; });
        if (reply) {
          await act(pi, ctx as unknown as NotifyCtx, reply.effects);
          text = reply.text as string;
        }
        return { content: [{ type: "text", text }], details: undefined };
      },
    });
  }

  // /keel itself starts a compaction (src/compaction.ts); the others answer with what to tell and send.
  for (const command of SURFACE.commands) {
    if (!command.suffix) continue;
    registerCommand(pi, binding, command.suffix, {
      description: command.description,
      handler: async (args: string, ctx: any) => {
        const reply = whenCore(() => ask(ctx, { op: "command", suffix: command.suffix, args, projectFiles: projectFiles(ctx) }), (why) => tell(ctx, why, "warning"));
        if (reply) await act(pi, ctx, reply.effects);
      },
    });
  }

  // A session starting carries the user's named notes of the project's last session.
  pi.on("session_start", (_event, ctx) => {
    const files = projectFiles(ctx as HostCtx);
    if (files.length === 0) return;
    const reply = whenCore(() => ask(ctx, { op: "session-start", projectFiles: files }));
    if (reply) void act(pi, ctx, reply.effects);
  });

  // What an assistant's message proves of the model's window: the limit an error states, the prompt accepted.
  pi.on("message_end", (event, ctx) => {
    if ((event.message as { role?: string })?.role !== "assistant") return;
    whenCore(() => ask(ctx, { op: "message-end", message: event.message }));
  });

  // Before every request: what is out of the context leaves it, one line in its place, and past
  // 85% of the host's trigger the oldest finished turns leave by themselves. The session file keeps every word.
  const evictTypes = new Set<string>(SURFACE.evictEntryTypes);
  pi.on("context", (event, ctx) =>
    whenCore(() => {
      // With the setting off and nothing taken out, the request is spared the call, and the
      // snapshot (the whole session tree, serialized) is never built for it.
      const out = hostBranch((ctx as HostCtx).sessionManager)?.some((e: any) => e?.type === "custom" && evictTypes.has(e.customType));
      if (!out && !binding.config.load().evict) return undefined;
      const reply = ask(ctx, { op: "context", messages: event.messages, tool: evictOn });
      void act(pi, ctx, reply.effects);
      return reply.messages ? { messages: reply.messages as typeof event.messages } : undefined;
    }));
};
