// A summary compiled from test input, by the core (tests/support/compile.ts):
// blocks (the summary's units: a user message, an assistant's text, a tool call
// and its result, a command the user ran) turned back into the messages a
// compaction compiles a summary from, so a test can say what a session did in
// few words and read what the summary makes of it: its text, its sections,
// and the state it stores for the next compaction.
import type { NormalizedBlock } from "./compile";
import { compileSummary, type CompileInput, type CompiledSummary } from "./compile";
import { DEFAULT_SUMMARY_LIMITS } from "./window";

/** Large enough that no section is capped: what the window gives, whole. */
export const UNCAPPED = { userMessages: 1000, filesPerCategory: 1000, commits: 1000, historyRanges: 1000, briefLines: 100000, commandsPerName: 1000 };

/** The messages these blocks are of, and the #N of each (the blocks' sourceIndex; none where a block has none). */
export const messagesOf = (blocks: readonly NormalizedBlock[]): { messages: any[]; sourceIndices: Array<number | undefined> } => {
  const failed = new Set(blocks.flatMap((b) => (b.kind === "tool_call" && b.failed && b.id ? [b.id] : [])));
  const messages: any[] = [];
  const sourceIndices: Array<number | undefined> = [];
  for (const b of blocks) {
    // A block with no sourceIndex has no #N: the summary shows it with no ref.
    const at = (b as { sourceIndex?: number }).sourceIndex;
    sourceIndices.push(at);
    switch (b.kind) {
      case "user":
        messages.push({ role: "user", content: b.text, ...(b.injected ? { injected: true } : {}) });
        break;
      case "assistant":
        messages.push({ role: "assistant", content: [{ type: "text", text: b.text }] });
        break;
      case "tool_call": {
        const id = b.id ?? `call-${messages.length}`;
        messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: b.name, arguments: b.args }] });
        // A call marked failed with no result of its own in the blocks: the error result that says so.
        if (b.failed && !blocks.some((r) => r.kind === "tool_result" && r.callId === id)) {
          messages.push({ role: "toolResult", toolCallId: id, toolName: b.name, content: [{ type: "text", text: "Error" }], isError: true });
          sourceIndices.push(undefined);
        }
        break;
      }
      case "tool_result":
        messages.push({ role: "toolResult", toolCallId: b.callId, toolName: b.name, content: [{ type: "text", text: b.text }], isError: b.callId !== undefined && failed.has(b.callId) });
        break;
      case "bash":
        messages.push(b.lang === "python"
          ? { role: "pythonExecution", code: b.command, output: b.output, exitCode: b.exitCode }
          : { role: "bashExecution", command: b.command, output: b.output, exitCode: b.exitCode });
        break;
    }
  }
  return { messages, sourceIndices };
};

/** The summary of these blocks (or messages), compiled as a compaction compiles it. */
export const summarize = (input: readonly NormalizedBlock[] | { messages: any[] }, options: Partial<CompileInput> = {}): CompiledSummary => {
  const { messages, sourceIndices } = Array.isArray(input) ? messagesOf(input as NormalizedBlock[]) : { messages: (input as { messages: any[] }).messages, sourceIndices: undefined };
  return compileSummary({ limits: DEFAULT_SUMMARY_LIMITS, ...options, messages, ...(sourceIndices && !options.sourceIndices ? { sourceIndices } : {}) });
};

/** A section's lines, their "- " cut off; [] when the summary has none. */
export const sectionLines = (text: string, name: string): string[] => {
  const head = text.split("\n\n---\n\n")[0];
  const at = head.indexOf(`[${name}]\n`);
  if (at < 0) return [];
  const body = head.slice(at + name.length + 3).split("\n\n")[0];
  return body.split("\n").map((l) => l.replace(/^- /, ""));
};

/** The brief: the transcript after the header sections. */
export const briefOf = (text: string): string => text.split("\n\n---\n\n")[1] ?? "";
