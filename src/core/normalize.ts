import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent";
import type { NormalizedBlock } from "../types";
import { isObject, readableMessage, textOf } from "./content";
import { sanitize } from "./sanitize";
import { toolCallOf } from "./tools";

const normalizeOne = (
  msg: SessionMessageEntry["message"],
  msgIndex: number | undefined,
  failedCallIds?: ReadonlySet<string>,
): NormalizedBlock[] => {
  if (msg.role === "user") {
    const blocks: NormalizedBlock[] = [];
    const text = sanitize(textOf(msg.content));
    const injected = (msg as { injected?: boolean }).injected === true;
    if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex, ...(injected ? { injected } : {}) });
    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex: msgIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }

  if (msg.role === "bashExecution") {
    const cmd = msg.command ?? "";
    const out = msg.output ?? "";
    const exit = msg.exitCode;
    return [{ kind: "bash", command: cmd, output: out, exitCode: exit, sourceIndex: msgIndex }];
  }

  // omp: a python cell the user ran themselves.
  if ((msg as { role: string }).role === "pythonExecution") {
    const py = msg as unknown as { code?: string; output?: string; exitCode?: number };
    return [{ kind: "bash", command: py.code ?? "", output: py.output ?? "", exitCode: py.exitCode, sourceIndex: msgIndex, lang: "python" }];
  }

  if (msg.role === "toolResult") {
    return [{
      kind: "tool_result",
      ...(typeof msg.toolCallId === "string" ? { callId: msg.toolCallId } : {}),
      name: msg.toolName,
      text: sanitize(textOf(msg.content)),
      sourceIndex: msgIndex,
    }];
  }

  if (msg.role === "assistant") {
    if (!msg.content) return [];
    if (typeof msg.content === "string") {
      return [{ kind: "assistant", text: sanitize(msg.content), sourceIndex: msgIndex }];
    }

    const blocks: NormalizedBlock[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text), sourceIndex: msgIndex });
      } else {
        const call = toolCallOf(part);
        if (!call) continue;
        blocks.push({
          kind: "tool_call",
          ...(call.id !== undefined ? { id: call.id } : {}),
          name: call.name,
          args: call.args,
          sourceIndex: msgIndex,
          ...(call.id !== undefined && failedCallIds?.has(call.id) ? { failed: true as const } : {}),
        });
      }
    }
    return blocks;
  }

  return [];
};

/**
 * Normalize messages to blocks. `sourceIndices`, when provided, supplies the
 * session-global `#N` index per input position (see src/core/session-file.ts).
 * A missing entry yields `sourceIndex: undefined`, which downstream renderers
 * display as no ref — never a window-relative number. Omitted entirely, the
 * legacy positional behavior is preserved (used by callers/tests that have no
 * index space to map into).
 */
export const normalize = (
  messages: SessionMessageEntry["message"][],
  sourceIndices?: Array<number | undefined>,
): NormalizedBlock[] => {
  // Calls whose result is an error, so the call itself can say so: the brief
  // shows calls, not results.
  const failedCallIds = new Set<string>();
  const readable = messages.map((msg) => (isObject(msg) ? (readableMessage(msg) as typeof msg) : undefined));
  for (const msg of readable) {
    if (msg?.role === "toolResult" && msg.isError === true && typeof msg.toolCallId === "string") failedCallIds.add(msg.toolCallId);
  }
  return readable.flatMap((msg, i) => (msg ? normalizeOne(msg, sourceIndices ? sourceIndices[i] : i, failedCallIds) : []));
};


