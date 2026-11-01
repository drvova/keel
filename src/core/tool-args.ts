export const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

export const extractPath = (args: Record<string, unknown>): string | null => {
  for (const key of ["path", "file_path", "filePath", "file"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return null;
};

/** A `[PATH#TAG]` section header of omp's hashline edit (TAG: four hex digits). */
const HASHLINE_HEADER_RE = /^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\][ \t]*$/gm;

/** Files an omp hashline `edit` call changes: its `input` holds one `[PATH#TAG]` section per file. */
export const hashlineEditPaths = (args: Record<string, unknown>): string[] =>
  typeof args.input === "string"
    ? [...new Set([...args.input.matchAll(HASHLINE_HEADER_RE)].map((m) => m[1].trim()).filter(Boolean))]
    : [];

/**
 * Every file a tool call names: its single path arg, else a string-array `paths`
 * arg (multi-file edit tools), else the section headers of an omp hashline edit.
 */
export const extractPaths = (args: Record<string, unknown>): string[] => {
  const one = extractPath(args);
  if (one) return [one];
  if (Array.isArray(args.paths)) return args.paths.filter((p): p is string => typeof p === "string" && p !== "");
  return hashlineEditPaths(args);
};

/**
 * omp's `read` takes a trailing selector on the path (`src/a.ts:50-100`, `:raw`,
 * `:-20`, `:1-12,-15`). Drop it so one file is listed once. Only selector
 * shapes match, so a path that merely contains `:` is left alone.
 */
const READ_SELECTOR_PART = "(?:raw|img|conflicts|L?\\d+(?:(?:-|\\.\\.|\\+)L?\\d*)?|-\\d+)";
const READ_SELECTOR_RE = new RegExp(`:${READ_SELECTOR_PART}(?:[,:]${READ_SELECTOR_PART})*$`);

export const stripReadSelector = (path: string): string => {
  const stripped = path.replace(READ_SELECTOR_RE, "");
  return stripped || path;
};

export const summarizeToolArgs = (args: Record<string, unknown>): string => {
  const [path, ...more] = extractPaths(args);
  if (path) return `path=${path}${more.length ? ` +${more.length}` : ""}`;
  if (typeof args.command === "string") return `command=${args.command}`;
  if (typeof args.query === "string") return `query=${args.query}`;
  return Object.keys(args).join(", ");
};
