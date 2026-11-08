import { searchHits } from "./support/pairs";
import { callRecallTool, recallTool } from "./support/binding";
import { sessionFileOfEntries } from "./support/session-files";
import { describe, it, expect, beforeAll } from "bun:test";
import { createHash } from "crypto";
import { RECALL_OUTPUT_CHARS } from "./support/names";

// One tool result is a ~600 KB base64 image on a single line (issue #63).
const blob = Buffer.concat(Array.from({ length: 14_000 }, (_, i) => createHash("sha256").update(String(i)).digest())).toString("base64");

let file: string;
const ids: string[] = [];
let blobIndex = -1;
let longLineIndex = -1;
// A long single line that is not base64 (minified code, a JSON event): search keeps it.
const longLine = `${"a1,".repeat(100_000)}needle_mark${"b2,".repeat(100_000)}`;

beforeAll(() => {
  const lines: unknown[] = [];
  const add = (message: unknown) => {
    const id = `e${ids.length}`;
    lines.push({ type: "message", id, parentId: ids.at(-1) ?? null, message });
    ids.push(id);
  };
  for (let i = 0; i < 60; i++) {
    if (i === 30) {
      add({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "other_tool", arguments: { action: "tail" } }] });
      blobIndex = ids.length;
      add({ role: "toolResult", toolCallId: "t1", toolName: "other_tool", content: [{ type: "text", text: blob }] });
      continue;
    }
    if (i === 40) {
      longLineIndex = ids.length;
      add({ role: "user", content: longLine });
      continue;
    }
    add({ role: "user", content: i % 10 === 0 ? `Step ${i}: set max retries to 3` : `Step ${i}: run the tests` });
    add({ role: "assistant", content: [{ type: "text", text: `Done with step ${i}.` }] });
  }
  file = sessionFileOfEntries(lines).file;
});

const recall = (params: Record<string, unknown>) => callRecallTool(recallTool(), file, params, ids);

describe("keel_recall output size (issue #63)", () => {
  it("keeps a search snippet of a long single-line entry small", async () => {
    const out = await recall({ query: "needle_mark" });
    expect(out).toContain(`#${longLineIndex} [user]`);
    expect(out).toContain("needle_mark");
    expect(out.length).toBeLessThan(5_000);
    expect(out).not.toContain("Warning: output clipped");
  });

  it("ranks entries with every term above a blob that only contains one inside base64", async () => {
    expect(blob).toMatch(/max/i);
    const out = await recall({ query: "max retries" });
    const first = out.match(/^#(\d+) /m)?.[1];
    expect(out.slice(out.indexOf(`#${first} `)).split("\n")[0]).toContain("max retries");
    expect(out).not.toContain(`#${blobIndex} `);
  });

  it("clips an expand over the cap and says so first", async () => {
    const out = await recall({ expand: [blobIndex] });
    expect(out.startsWith(`Warning: output clipped at ${RECALL_OUTPUT_CHARS} of `)).toBe(true);
    expect(out.length).toBeLessThan(RECALL_OUTPUT_CHARS + 500);
    expect(out.endsWith("...[clipped at 50 KB]")).toBe(true);
  });
});

describe("search ranking with a long unbroken entry", () => {
  it("leaves the order of the other entries unchanged", () => {
    // A short doc with one hit and a long doc with many: their order depends on the average doc length.
    const texts = [
      "set max to 3",
      `${"filler ".repeat(60)} max max max max`,
      "the max retries value",
      `${"note ".repeat(20)} max max`,
    ];
    const plain = texts.map((t, i) => ({ entry: { index: i, role: "user", summary: t }, msg: { role: "user", content: t } }));
    const blobDoc = { entry: { index: 4, role: "tool_result", summary: "[other_tool]" }, msg: { role: "toolResult", toolName: "other_tool", content: [{ type: "text", text: `max ${blob}` }] } };
    const order = (docs: typeof plain) =>
      searchHits(docs.map((d) => d.msg), "max").map((h) => h.index).filter((i) => i !== 4);
    expect(order([...plain, blobDoc as any])).toEqual(order(plain));
  });

  it("keeps long joined identifiers searchable", () => {
    const joined = "capturedNormalCompletionRecordOrdinaryObjectCreateDataProperty".repeat(30);
    const hits = searchHits([{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: joined }] }], "OrdinaryObjectCreate");
    expect(hits.map((h) => h.index)).toEqual([0]);
  });
});
