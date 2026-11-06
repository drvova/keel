// Pi's append-only context edits, applied to a branch as Pi applies them.
//
// Pi never rewrites an entry. A later `context_edit` entry changes what one
// earlier entry contributes to the model's context: `replacement: null` omits
// it (Pi does this itself for an assistant attempt it retries after an
// overflow), a replacement swaps its content and keeps its role and metadata.
// Pi's own compaction and branch summaries read the edited context; only raw
// history (exports, recall over the session file) reads past the edits. So the
// compaction hook reads the branch through this projection: what Pi will send
// is what it summarizes and what it keeps.
//
// A port of Pi's buildSessionProjection / projectContextEntry
// (core/session-manager.ts), not an import, so the shared code imports no host
// at runtime. omp writes no context_edit entries, so on omp the branch comes
// back unchanged.

/** The roles whose content a replacement changes (Pi's projectContextEntry). */
const EDITABLE_ROLES = new Set(["user", "assistant", "toolResult", "custom"]);

interface ContextEdit {
  targetId: string;
  replacement: { content: unknown } | null;
}

const isContextEdit = (entry: any): entry is ContextEdit & { type: "context_edit" } =>
  entry?.type === "context_edit" && typeof entry.targetId === "string";

/** A replacement's content for a message of `role`: a string becomes one text block where Pi's types want blocks. */
const replacedContent = (role: string, content: unknown): unknown =>
  (role === "assistant" || role === "toolResult") && typeof content === "string" ? [{ type: "text", text: content }] : content;

/**
 * Each entry of the branch as Pi's context holds it, in place: undefined for
 * one an edit omits and for the edit entries themselves (they contribute no
 * message), the new content for a replaced one. Each target takes the latest
 * edit aimed at it. Undefined when the branch has no edits (every omp branch).
 */
export const projectContextEdits = <E>(branchEntries: E[]): Array<E | undefined> | undefined => {
  const edits = new Map<string, ContextEdit>();
  for (const entry of branchEntries) if (isContextEdit(entry)) edits.set(entry.targetId, entry);
  if (edits.size === 0) return undefined;
  return branchEntries.map((entry) => {
    const e = entry as any;
    if (isContextEdit(e)) return undefined;
    const edit = typeof e?.id === "string" ? edits.get(e.id) : undefined;
    if (!edit) return entry;
    if (edit.replacement === null) return undefined;
    const content = edit.replacement?.content;
    if (e.type === "message" && e.message && EDITABLE_ROLES.has(e.message.role)) {
      return { ...e, message: { ...e.message, content: replacedContent(e.message.role, content) } };
    }
    if (e.type === "custom_message") return { ...e, content };
    return entry;
  });
};

/**
 * The branch as Pi's context holds it: entries an edit omits are left out,
 * replaced ones carry the new content, and the edit entries themselves are
 * dropped. Entries without edits are returned as they are, so a branch with
 * none (every omp branch) comes back as the same array. The Lisp core applies
 * the same projection (lisp/src/context-edits.lisp).
 */
export const applyContextEdits = <E>(branchEntries: E[]): E[] =>
  projectContextEdits(branchEntries)?.filter((e): e is E => e !== undefined) ?? branchEntries;
