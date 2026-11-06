import type { Message } from "@oh-my-pi/pi-ai";
import { clip, textOf } from "./content";
import { callSubject, fileWriteOf, namedPaths, toolCallsOf, type ToolCall } from "./tools";

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
  files?: string[];
  /** Short id of the earlier session the entry is from (scope:'project' search); unset for this session. */
  session?: string;
}

/** A call in one line: `name(key=value)`, the argument it is about; else its argument names. */
const callLine = (c: ToolCall): string => {
  const subject = callSubject(c);
  const what = subject
    ? `${subject.label}=${subject.value}${subject.more ? ` +${subject.more}` : ""}`
    : Object.keys(c.args).join(", ");
  return `${c.name}(${what})`;
};

const indent = (text: string, pad: string): string => text.replace(/^(?=.)/gm, pad);

/**
 * One expanded call's arguments, and the tool output shown with it, are clipped
 * here under the 50 KB recall cap; a smaller cap (a smaller window) clips them
 * at the same share of it (expandDetailChars in recall-run.ts).
 */
export const EXPAND_DETAIL_CHARS = 4000;
/** omp's per-call intent line, shown in its UI; not an argument of the call. */
const NOT_ARGUMENTS = new Set(["i"]);

/**
 * The arguments the one-line `name(…)` summary leaves out, for the full view.
 * Search reads every argument, so a hit inside one (a write's content, an
 * edit's new text) is shown by expand too. String values print as written,
 * indented; others as JSON.
 */
const fullToolArgs = (calls: ToolCall[], index: number, maxChars: number): string => {
  const blocks = calls.map((c) => {
    const shown = new Set(callSubject(c)?.keys ?? []);
    // A value's later lines sit deeper than its key, so they never read as another argument.
    const lines = Object.entries(c.args)
      .filter(([key, value]) => !shown.has(key) && !NOT_ARGUMENTS.has(key) && value !== undefined)
      .map(([key, value]) => `${key}: ${(typeof value === "string" ? value.replace(/\s+$/, "") : JSON.stringify(value)).replace(/\n/g, "\n  ")}`);
    return { name: c.name, lines };
  }).filter((b) => b.lines.length > 0);
  // With several calls in one message, each block says whose arguments it holds.
  const labelled = blocks.length > 1;
  const text = blocks
    .map((b) => (labelled ? `  ${b.name}:\n${indent(b.lines.join("\n"), "    ")}` : indent(b.lines.join("\n"), "  ")))
    .join("\n");
  if (text.length <= maxChars) return text;
  // A write's or edit's content is still all there through the file drill-down.
  const path = calls.map(fileWriteOf).find(Boolean)?.path;
  const rest = path ? `; query '#${index}:${path}:full' reads the file content` : "";
  return `${text.slice(0, maxChars)}\n  ...[arguments of #${index} clipped at ${maxChars} of ${text.length} chars${rest}]`;
};

/** Paths of an omp fileMention message. */
export const fileMentionPaths = (msg: unknown): string[] => {
  const files = (msg as { files?: unknown }).files;
  return Array.isArray(files)
    ? files.map((f) => (f as { path?: unknown })?.path).filter((p): p is string => typeof p === "string" && p !== "")
    : [];
};

export const renderMessage = (msg: Message, index: number, full = false, detailChars = EXPAND_DETAIL_CHARS): RenderedEntry => {
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
  const calls = toolCallsOf(msg);
  const tools = calls.map(callLine).join(", ");
  const files = calls.flatMap((c) => namedPaths(c.args));
  const args = full && tools ? fullToolArgs(calls, index, detailChars) : "";
  const summary = tools ? [tools, args, text].filter(Boolean).join("\n") : text;
  return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
};


