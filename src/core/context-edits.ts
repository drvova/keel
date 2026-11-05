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
 * The branch as Pi's context holds it: entries an edit omits are left out,
 * replaced ones carry the new content, and the edit entries themselves are
 * dropped (they contribute no message). Each target takes the latest edit
 * aimed at it. Entries without edits are returned as they are, so a branch
 * with none (every omp branch) comes back as the same array.
 */
export const applyContextEdits = <E>(branchEntries: E[]): E[] => {
  const edits = new Map<string, ContextEdit>();
  for (const entry of branchEntries) if (isContextEdit(entry)) edits.set(entry.targetId, entry);
  if (edits.size === 0) return branchEntries;
  const projected: E[] = [];
  for (const entry of branchEntries) {
    const e = entry as any;
    if (isContextEdit(e)) continue;
    const edit = typeof e?.id === "string" ? edits.get(e.id) : undefined;
    if (!edit) {
      projected.push(entry);
      continue;
    }
    if (edit.replacement === null) continue;
    const content = edit.replacement?.content;
    if (e.type === "message" && e.message && EDITABLE_ROLES.has(e.message.role)) {
      projected.push({ ...e, message: { ...e.message, content: replacedContent(e.message.role, content) } });
    } else if (e.type === "custom_message") {
      projected.push({ ...e, content });
    } else {
      projected.push(entry);
    }
  }
  return projected;
};
