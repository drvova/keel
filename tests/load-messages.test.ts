import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSession, renderMessages } from "../src/core/load-messages";

// A session file as a recall view loads it (recall-run.ts): read, then rendered.
const load = (file: string, full: boolean, allowed?: ReadonlySet<string>) => renderMessages(readSession(file).messages, full, allowed);

describe("reading a session for recall", () => {
  it("loads all message entries when no lineage filter is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-load-all-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "custom", id: "c1", customType: "x", data: {} }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "m3", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = load(file, false);
      expect(loaded.map((m) => m.entry.index)).toEqual([0, 1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips system messages but keeps their #N index slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-load-system-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "message", id: "s0", message: { role: "system", content: "", sections: { preamble: "p" } } }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "message", id: "s1", message: { role: "system", content: "", toolsAdded: [] } }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = load(file, false);
      expect(loaded.map((m) => [m.entry.index, m.entry.role, m.message.role])).toEqual([[1, "user", "user"], [3, "assistant", "assistant"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads JSONL incrementally across read-chunk boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-load-chunked-"));
    const file = join(dir, "session.jsonl");
    try {
      const largeText = `${"x".repeat(70_000)} unicode: λ`;
      const lines = [
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: largeText } }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "after boundary" } }),
      ];
      // Deliberately omit the final newline to cover the buffered tail as well.
      writeFileSync(file, lines.join("\n"), "utf8");

      const loaded = load(file, true);
      expect(loaded.map((m) => m.entry.summary)).toEqual([largeText, "after boundary"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a not-yet-written session file as empty history instead of throwing ENOENT", () => {
    // Fresh session: pi has not persisted any entry, so the JSONL does not exist.
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-load-missing-"));
    try {
      const loaded = load(join(dir, "nope", "session.jsonl"), false);
      expect(loaded).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty history for an existing but empty session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-load-empty-"));
    const file = join(dir, "session.jsonl");
    try {
      writeFileSync(file, "", "utf8");
      const loaded = load(file, false);
      expect(loaded).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still surfaces read errors that are not 'file does not exist'", () => {
    // A directory is readable-but-not-a-file (EISDIR): a real I/O problem, not
    // an empty history. It must not be swallowed.
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-load-eisdir-"));
    try {
      expect(() => load(dir, false)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters messages by allowed lineage entry IDs and preserves original message index", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-vcc-load-filter-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: "u2" } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = load(file, false, new Set(["m2"]));
      expect(loaded.map((m) => [m.entry.index, m.message.role])).toEqual([[1, "assistant"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
