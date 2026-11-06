// The tool calls a session holds, read one way: what a call does, the files it
// names, the command it runs and the text it writes. The vocabulary is the
// hosts' own tools: omp's (src/tools and src/edit: read, write, edit in its
// replace, patch, apply_patch and hashline modes, ast_edit, grep, glob, find,
// ast_grep, bash) and Pi's (dist/core/tools: read, write, edit with `edits[]`,
// grep, find, ls, bash, powershell). Another extension's tool is read by the
// same argument shapes.
import type { NormalizedBlock } from "../types";
import { isObject } from "./content";

export interface ToolCall {
  id: string | undefined;
  name: string;
  args: Record<string, unknown>;
}

/** A content part as a tool call, its name a string and its arguments an object; undefined for any other part. */
export const toolCallOf = (part: unknown): ToolCall | undefined =>
  isObject(part) && part.type === "toolCall"
    ? {
        id: typeof part.id === "string" ? part.id : undefined,
        name: typeof part.name === "string" ? part.name : "unknown",
        args: isObject(part.arguments) ? part.arguments : {},
      }
    : undefined;

/** The tool calls of a message, in order. */
export const toolCallsOf = (message: unknown): ToolCall[] => {
  const content = isObject(message) ? message.content : undefined;
  return Array.isArray(content) ? content.flatMap((part) => toolCallOf(part) ?? []) : [];
};

/** What a call does to the project. */
type CallKind = "read" | "write" | "edit" | "search" | "shell" | "other";

const KIND_BY_NAME: Readonly<Record<string, CallKind>> = {
  read: "read",
  write: "write",
  edit: "edit",
  ast_edit: "edit",
  grep: "search",
  glob: "search",
  find: "search",
  ast_grep: "search",
  ls: "search",
  bash: "shell",
  powershell: "shell",
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A replace edit's old text: Pi's `oldText`, omp's `old_string`. */
const oldTextOf = (o: Record<string, unknown>): string | undefined => str(o.oldText) ?? str(o.old_string);
/** A replace edit's new text: Pi's `newText`, omp's `new_string`. */
const newTextOf = (o: Record<string, unknown>): string | undefined => str(o.newText) ?? str(o.new_string);
const isReplace = (o: Record<string, unknown>): boolean => oldTextOf(o) !== undefined || newTextOf(o) !== undefined;
const editEntries = (args: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(args.edits) ? args.edits.filter(isObject) : [];

/**
 * The kind of a host's tool by its name (omp canonicalizes its built-in names to
 * lower case); another tool's by its arguments: a file and its content is a
 * write, a file and old and new text (or `edits[]`) an edit.
 */
export const callKind = (call: Pick<ToolCall, "name" | "args">): CallKind => {
  const named = KIND_BY_NAME[call.name.toLowerCase()];
  if (named) return named;
  const { args } = call;
  if (namedPaths(args).length === 0) return "other";
  if (typeof args.content === "string") return "write";
  if (isReplace(args) || editEntries(args).length > 0) return "edit";
  return "other";
};

/** The argument a file tool names its file by: the hosts' `path`; the others other extensions' tools use. */
const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

const pathKeyOf = (args: Record<string, unknown>): (typeof PATH_KEYS)[number] | undefined =>
  PATH_KEYS.find((k) => typeof args[k] === "string" && args[k] !== "");

/** A `[PATH#TAG]` section header of omp's hashline edit (TAG: four hex digits). */
const HASHLINE_HEADER_RE = /^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\][ \t]*$/gm;
/** A file header of omp's apply_patch edit (`*** Update File: src/app.py`, `*** Move to: …`). */
const APPLY_PATCH_HEADER_RE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)[ \t]*$/gm;

/** The files named in an omp edit's `input`: its hashline section headers, or its apply_patch file headers. */
const inputPaths = (input: unknown): string[] =>
  typeof input === "string"
    ? [...new Set([...input.matchAll(HASHLINE_HEADER_RE), ...input.matchAll(APPLY_PATCH_HEADER_RE)].map((m) => m[1].trim()).filter(Boolean))]
    : [];

/**
 * Every path a call names, as it names it: its path argument, else `paths`
 * (omp's ast_edit), else the files in an omp edit's `input`.
 */
export const namedPaths = (args: Record<string, unknown>): string[] => {
  const key = pathKeyOf(args);
  if (key) return [args[key] as string];
  if (Array.isArray(args.paths)) return args.paths.filter((p): p is string => typeof p === "string" && p !== "");
  return inputPaths(args.input);
};

/**
 * A path with a URL scheme (omp's `artifact://` store for shaken tool output,
 * `skill://`, `http://`…) is not a project file: tools read it, but it is left
 * out of file lists.
 */
export const isUrlPath = (path: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(path);

/**
 * omp's `read` takes a selector after the path (tools/read-selector.ts):
 * `:raw`, `:img`, `:conflicts`, line ranges (`:50-100`, `:L50-L60`, `:50+10`,
 * `:50-`), a tail (`:-20`), lists of them (`:1-12,-15`) and both (`:raw:50-100`).
 * Only selector shapes match, so a path that merely contains `:` is left alone.
 */
const SELECTOR_LINES = "L?\\d+(?:(?:-|\\.\\.|\\+)L?\\d*)?|-\\d+(?:[-+]\\d+)?";
const SELECTOR_CHUNK = `(?:raw|img|conflicts|${SELECTOR_LINES})`;
const READ_SELECTOR_RE = new RegExp(`:${SELECTOR_CHUNK}(?:[,:]${SELECTOR_CHUNK})*$`, "i");
const LINES_CHUNK_RE = new RegExp(`^(?:${SELECTOR_LINES})$`, "i");

/** A read's path split into the file and its selector (`""` for none). */
const splitSelector = (path: string): { file: string; selector: string } => {
  const m = path.match(READ_SELECTOR_RE);
  return m && m.index ? { file: path.slice(0, m.index), selector: m[0] } : { file: path, selector: "" };
};

export const stripReadSelector = (path: string): string => splitSelector(path).file;

/**
 * The files a call works on, one name per file: its named paths less URLs, a
 * read's selector dropped. A search's path is where it looked, not a file it
 * worked on, so it names none.
 */
export const filesOf = (call: Pick<ToolCall, "name" | "args">): string[] => {
  const kind = callKind(call);
  if (kind === "search" || kind === "shell") return [];
  const paths = namedPaths(call.args).filter((p) => !isUrlPath(p));
  return kind === "read" ? paths.map(stripReadSelector) : paths;
};

/** A read of part of a file: omp's line selector, or Pi's `offset`/`limit`. */
export const readsPart = (call: Pick<ToolCall, "name" | "args">): boolean => {
  if (callKind(call) !== "read") return false;
  if (call.args.offset !== undefined || call.args.limit !== undefined) return true;
  const [path] = namedPaths(call.args);
  const selector = path ? splitSelector(path).selector : "";
  return selector.slice(1).split(/[,:]/).some((chunk) => LINES_CHUNK_RE.test(chunk));
};

/** The shell command a block ran: a shell tool call's `command`, or a `!cmd` the user ran. */
export const commandOf = (block: NormalizedBlock): string | undefined => {
  if (block.kind === "bash") return block.lang === undefined ? block.command : undefined;
  if (block.kind === "tool_call" && callKind(block) === "shell") return str(block.args.command);
  return undefined;
};

/**
 * What a call is about, for a one-line rendering: a shell call's command, a
 * search's pattern, else its file (and how many more it names), command or
 * query. `keys` are the arguments it shows.
 */
interface CallSubject {
  label: "path" | "command" | "pattern" | "query";
  value: string;
  more: number;
  keys: readonly string[];
}

export const callSubject = (call: Pick<ToolCall, "name" | "args">): CallSubject | undefined => {
  const { args } = call;
  const kind = callKind(call);
  const one = (label: CallSubject["label"], key: string = label): CallSubject | undefined => {
    const value = str(args[key]);
    return value ? { label, value, more: 0, keys: [key] } : undefined;
  };
  if (kind === "shell") return one("command");
  if (kind === "search") {
    const pattern = one("pattern") ?? one("pattern", "pat");
    if (pattern) return pattern;
  }
  const [path, ...more] = namedPaths(args);
  if (path) {
    const key = pathKeyOf(args) ?? (Array.isArray(args.paths) ? "paths" : undefined);
    return { label: "path", value: path, more: more.length, keys: key ? [key] : [] };
  }
  return one("command") ?? one("query");
};

/**
 * What a call writes into one file, for the drill-down: a write's whole
 * content, each of its edits' old and new text, or a single replace's.
 */
export interface FileWrite {
  path: string;
  content?: string;
  edits?: { oldText: string; newText: string }[];
  replace?: { oldText: string; newText: string };
}

export const fileWriteOf = (call: Pick<ToolCall, "name" | "args">): FileWrite | undefined => {
  const kind = callKind(call);
  if (kind !== "write" && kind !== "edit") return undefined;
  const { args } = call;
  const key = pathKeyOf(args);
  if (!key) return undefined;
  const path = args[key] as string;
  if (typeof args.content === "string" && args.content !== "") return { path, content: args.content };
  const edits = editEntries(args).filter(isReplace);
  if (edits.length > 0) return { path, edits: edits.map((e) => ({ oldText: oldTextOf(e) ?? "", newText: newTextOf(e) ?? "" })) };
  if (isReplace(args)) return { path, replace: { oldText: oldTextOf(args) ?? "", newText: newTextOf(args) ?? "" } };
  return undefined;
};

/**
 * The text a write or edit puts into files: a write's content, each edit's old
 * and new text (or omp's patch diff), a single replace's, an omp edit's `input`.
 */
export const writtenText = (args: Record<string, unknown>): string => {
  const parts: (string | undefined)[] = [str(args.content)];
  for (const e of editEntries(args)) parts.push(oldTextOf(e), newTextOf(e), str(e.diff));
  if (!Array.isArray(args.edits)) parts.push(oldTextOf(args), newTextOf(args));
  parts.push(str(args.input));
  return parts.filter((p): p is string => p !== undefined).map((p) => `${p}\n`).join("");
};

/**
 * Every string argument of a call, for search: top-level strings and strings
 * one level into arrays (`edits`, `paths`). Unbounded: search applies one
 * budget across all of a message's calls.
 */
export const argsText = (args: Record<string, unknown>): string => {
  const parts: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") parts.push(item);
        else if (isObject(item)) for (const v of Object.values(item)) if (typeof v === "string") parts.push(v);
      }
    }
  }
  return parts.join("\n");
};
