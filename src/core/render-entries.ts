import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { clip, textOf } from "./content";
import { summarizeToolArgs, extractPaths } from "./tool-args";

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
  files?: string[];
}

const toolCallParts = (content: Message["content"]): ToolCall[] => {
  if (!content || typeof content === "string") return [];
  return (content as { type: string }[]).filter((c): c is ToolCall => c.type === "toolCall");
};

const toolCalls = (content: Message["content"]): string => {
  return toolCallParts(content)
    .map((c) => `${c.name}(${summarizeToolArgs(c.arguments)})`)
    .join(", ");
};

const extractFilesFromContent = (content: Message["content"]): string[] => {
  return toolCallParts(content).flatMap((c) => extractPaths(c.arguments));
};

/** Paths of an omp fileMention message. */
export const fileMentionPaths = (msg: unknown): string[] => {
  const files = (msg as { files?: unknown }).files;
  return Array.isArray(files)
    ? files.map((f) => (f as { path?: unknown })?.path).filter((p): p is string => typeof p === "string" && p !== "")
    : [];
};

export const renderMessage = (msg: Message, index: number, full = false): RenderedEntry => {
  if (msg.role === "user") {
    return { index, role: "user", summary: full ? textOf(msg.content) : clip(textOf(msg.content), 300) };
  }
  if (msg.role === "toolResult") {
    const text = full ? textOf(msg.content) : clip(textOf(msg.content), 200);
    return {
      index, role: "tool_result",
      summary: `[${msg.toolName}] ${text}`,
    };
  }
  // bashExecution has command+output instead of content
  if ((msg as any).role === "bashExecution") {
    const cmd = (msg as any).command ?? "";
    const out = (msg as any).output ?? "";
    const text = full ? `$ ${cmd}\n${out}` : clip(`$ ${cmd}\n${out}`, 300);
    return { index, role: "bash", summary: text };
  }
  // omp roles. A python cell the user ran: code+output, like bashExecution.
  if ((msg as any).role === "pythonExecution") {
    const code = (msg as any).code ?? "";
    const out = (msg as any).output ?? "";
    const text = full ? `>>> ${code}\n${out}` : clip(`>>> ${code}\n${out}`, 300);
    return { index, role: "python", summary: text };
  }
  // An @file mention: the paths it inlined (their contents are the files themselves).
  if ((msg as any).role === "fileMention") {
    const paths = fileMentionPaths(msg);
    return { index, role: "file", summary: paths.map((p) => `@${p}`).join(" "), ...(paths.length > 0 && { files: paths }) };
  }
  // Host-written instruction turns and extension messages keep their own role.
  if ((msg as any).role === "developer" || (msg as any).role === "custom") {
    const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
    return { index, role: (msg as any).role, summary: text };
  }
  const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
  const tools = toolCalls(msg.content);
  const files = extractFilesFromContent(msg.content);
  const summary = tools ? `${tools}\n${text}` : text;
  return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
};


