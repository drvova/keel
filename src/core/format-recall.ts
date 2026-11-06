import type { SearchHit } from "./search-entries";

/** A follow-up call's params after the call: ` with session:'a' and scope:'all'`, "" for none. */
export const withParams = (...params: Array<string | undefined>): string => {
  const set = params.filter((p): p is string => !!p);
  return set.length > 0 ? ` with ${set.join(" and ")}` : "";
};

/** session:'id' for a call into an earlier session; nothing for this one. */
export const sessionParam = (short?: string): string | undefined => (short ? `session:'${short}'` : undefined);

/** The one answer for a page past the last of a paged listing. */
export const outsidePage = (page: number, totalPages: number, what: string): string =>
  `Page ${page} is outside the available range 1-${totalPages} (${what}).`;

export const formatRecallOutput = (
  entries: SearchHit[],
  query?: string,
  headerOverride?: string,
): string => {
  if (entries.length === 0) {
    return query
      ? `No matches for "${query}" in session history.`
      : "No entries in session history.";
  }

  // Search, range and touched pass their own header (count, page, scope).
  const header = headerOverride
    ? `${headerOverride}${query ? ` for "${query}"` : ""}:`
    : `Session history (${entries.length} entries):`;

  const lines = entries.map((e) => {
    const fileSuffix = e.files?.length ? ` files:[${e.files.join(", ")}]` : "";
    const body = query && e.snippet ? e.snippet : e.summary;
    const where = e.session ? `[session ${e.session}] ` : "";
    return `${where}#${e.index} [${e.role}]${fileSuffix} ${body}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
};
