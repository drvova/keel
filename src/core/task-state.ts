// [Task State]: where the work stands when a compaction lands.
//
// The other sections say what happened: requests, files, commits, a ranked
// transcript. What the agent needs first after a compaction is where it is in
// the task in progress: the request it is working on, what it has done since,
// whether its last step worked, and the failure it has not fixed yet. Agents
// that keep that state apart from the history recover better on long tasks
// (HyMem's typed results, arXiv:2608.15703; a fixed task segment beside the
// history, arXiv:2512.22087), and those papers have a model write it. Here it
// is read off the transcript by rule: the latest request and the tool calls
// after it, their results' failure flags and what they changed, from the
// originals of everything since /clear (what is summarized and what is kept).
// Nothing depends on wording. It is shown only when the request is summarized
// away (one still in context has all that followed it in context too), and like
// [Working Set] it is built again at every compaction and never carried.
import { textOf, clip, isExtensionUserMessage } from "./content";
import { userLine } from "../extract/user-messages";
import { callsOf, edits, runOf, titleOf, writes, type Call } from "./working-set";

/** omp's <system-reminder> text in a user message, which the user did not write (filter-noise.ts). */
const HOST_BLOCK_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g;
/** Changed files named in the section; past this the count says how many more. */
const CHANGED_SHOWN = 8;
/** An error line is clipped to this many characters. */
const ERROR_LINE_CHARS = 200;

interface TaskStateInput {
  /** Everything since /clear, oldest first, the originals of what omp rewrote put back: what is summarized, then what is kept. */
  messages: readonly unknown[];
  /** The session-wide #N of each, where known. */
  indices: ReadonlyArray<number | undefined>;
  /** Where the kept tail starts in `messages` (its length when nothing is kept). */
  keptFrom: number;
}

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});
const ref = (n: number | undefined): string => (n != null ? ` (#${n})` : "");

/** The last line of a result that says something: errors come last. */
const lastLine = (text: string): string => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return clip(lines.at(-1) ?? "", ERROR_LINE_CHARS);
};

/** The section's lines; none when no request is in the window. */
export const buildTaskState = (input: TaskStateInput): string[] => {
  const { messages, indices } = input;
  let at = -1;
  let request = "";
  for (let i = messages.length - 1; i >= 0 && at < 0; i--) {
    const m = asRecord(messages[i]);
    if (m.role !== "user" || isExtensionUserMessage(m)) continue;
    const line = userLine(textOf(m.content).replace(HOST_BLOCK_RE, ""), indices[i]);
    if (line) {
      at = i;
      request = line;
    }
  }
  // A request still in context has everything since it in context too: the section would only repeat it.
  if (at < 0 || at >= input.keptFrom) return [];
  const lines = [`Request${ref(indices[at])}: ${request}`];

  const calls = new Map<string, Call>();
  const results: Array<{ pos: number; call: Call | undefined; text: string; isError: boolean }> = [];
  let callCount = 0;
  for (let pos = at + 1; pos < messages.length; pos++) {
    const m = asRecord(messages[pos]);
    for (const c of callsOf(m, pos)) {
      calls.set(c.id, c);
      callCount++;
    }
    if (m.role === "toolResult") results.push({ pos, call: calls.get(m.toolCallId), text: textOf(m.content), isError: m.isError === true });
  }
  if (callCount === 0) return [...lines, "Since then: no tool calls yet."];

  const changed: string[] = [];
  for (const c of [...calls.values()].reverse()) {
    if (!(writes(c) || edits(c))) continue;
    for (const p of c.paths) if (!changed.includes(p)) changed.push(p);
  }
  const failed = results.filter((r) => r.isError).length;
  const shownChanged = changed.slice(0, CHANGED_SHOWN);
  const more = changed.length - shownChanged.length;
  lines.push(
    `Since then: ${callCount} tool call${callCount === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}` +
      (changed.length ? `; changed ${shownChanged.join(", ")}${more > 0 ? ` (+${more} more)` : ""}` : "; no file changed") + ".",
  );

  // The latest failure no later run of the same call fixed.
  let open: (typeof results)[number] | undefined;
  for (let k = results.length - 1; k >= 0 && !open; k--) {
    const r = results[k];
    if (!r.isError) continue;
    const key = r.call ? runOf(r.call) : undefined;
    const fixed = results.some((x) => x.pos > r.pos && !x.isError && x.call && key !== undefined && runOf(x.call) === key);
    if (!fixed) open = r;
  }
  const last = results.at(-1);
  if (last && last !== open) lines.push(`Last result${ref(indices[last.pos])}: ${titleOf(last.call)} ${last.isError ? "failed" : "succeeded"}.`);
  if (open) {
    const error = lastLine(open.text);
    lines.push(`Unresolved failure${ref(indices[open.pos])}: ${titleOf(open.call)}${error ? `: ${error}` : ""}`);
  }
  return lines;
};
