import { describe, test, expect } from "bun:test";
// Blocks the summarizer would actually get (renderedBlocks): the hook's
// toSummaryMessage, which reads custom messages as user content, then normalize.
import { applyTailBudget, buildOwnCut, renderedBlocks, resolveSmartKeepUserTurns } from "./support/host";

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

// A role:"system" message entry (a host's prompt/tool-loadout record), which
// omp's convertToLlm drops.
const sys = (id: string, content = "Available tools: read, bash, edit") => ({
  id,
  type: "message",
  message: { role: "system", content },
});

const comp = (id: string, firstKeptEntryId?: string) => ({
  id,
  type: "compaction",
  firstKeptEntryId,
});

describe("buildOwnCut", () => {
  test("no prior compaction: cuts at last user message", () => {
    const r = buildOwnCut([
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
    expect(r.compactAll).toBe(false);
  });

  test("cancels with too_few_live_messages when liveMessages <= 2", () => {
    const r = buildOwnCut([
      comp("c1", "m1"),
      msg("m1", "user", "x"),
      msg("m2", "assistant", "y"),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_few_live_messages");
  });

  test("orphan firstKeptEntryId triggers recovery (collect after compaction)", () => {
    // Prev compaction set firstKeptEntryId to a non-existent id (e.g. "" sentinel
    // from a previous compact-all). Recovery should collect msgs after compaction.
    const r = buildOwnCut([
      msg("old1", "user", "old"),
      msg("old2", "assistant", "old"),
      comp("c1", "ORPHAN_ID"),
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
  });

  test("resumes from firstKeptEntryId after prior compaction", () => {
    const r = buildOwnCut([
      msg("old1", "user", "old"),
      msg("old2", "assistant", "old"),
      comp("c1", "m1"),
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
  });

  test("single user prompt + autonomous tail: compact all", () => {
    // The Discord scenario: user types 1 prompt, agent runs autonomously
    // (assistant + toolResult interleaved). No user > idx 0.
    const r = buildOwnCut([
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "more"),
      msg("m5", "toolResult", "result2"),
      msg("m6", "assistant", "done"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(6);
  });

  test("no user message: compact-all instead of cancelling", () => {
    // When there are enough live messages but none are from the user
    // (e.g., long assistant/tool chain), compact all rather than
    // cancelling and leaving the session unrecoverable.
    const r = buildOwnCut([
      msg("m1", "assistant", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "assistant", "c"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(3);
  });

  test("compact-all then more chat: orphan recovery + normal cut", () => {
    // After a compact-all (firstKeptEntryId=""), user chats more turns,
    // next compaction should orphan-recover and find multiple users.
    const r = buildOwnCut([
      msg("o1", "user", "old"),
      msg("o2", "assistant", "old"),
      comp("c1", ""), // sentinel from prior compact-all
      msg("u1", "user", "new1"),
      msg("a1", "assistant", "reply1"),
      msg("u2", "user", "new2"),
      msg("a2", "assistant", "reply2"),
      msg("u3", "user", "new3"),
      msg("a3", "assistant", "reply3"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u3");
    expect(r.messages).toHaveLength(4); // u1, a1, u2, a2
  });

  test("compact-all then single user msg + autonomous: compact all again", () => {
    const r = buildOwnCut([
      msg("o1", "user", "old"),
      comp("c1", ""),
      msg("u1", "user", "okay"),
      msg("a1", "assistant", "x"),
      msg("t1", "toolResult", "y"),
      msg("a2", "assistant", "z"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
  });

  test("keep:2 keeps the last two user turns", () => {
    const r = buildOwnCut([
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "reply three"),
    ], 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u2");
    expect(r.messages).toHaveLength(2);
    expect(r.keptUserTurns).toBe(2);
    expect(r.totalUserTurns).toBe(3);
  });

  test("keep:2 falls back to compact-all when the boundary would start at the first user", () => {
    const r = buildOwnCut([
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
    ], 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(4);
    expect(r.keptUserTurns).toBe(0);
    expect(r.totalUserTurns).toBe(2);
    expect(r.requestedKeepUserTurns).toBe(2);
    expect(r.keepFallbackToCompactAll).toBe(true);
  });

  test("keep:0 compacts all and keeps no tail", () => {
    const r = buildOwnCut([
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
    ], 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(4);
    expect(r.keptUserTurns).toBe(0);
    expect(r.totalUserTurns).toBe(2);
  });

  test("keep larger than available user turns compacts all", () => {
    const r = buildOwnCut([
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
    ], 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(4);
    expect(r.keptUserTurns).toBe(0);
    expect(r.totalUserTurns).toBe(2);
  });

  test("orphan recovery respects keep user turns", () => {
    const r = buildOwnCut([
      msg("old1", "user", "old"),
      comp("c1", ""),
      msg("u1", "user", "new1"),
      msg("a1", "assistant", "reply1"),
      msg("u2", "user", "new2"),
      msg("a2", "assistant", "reply2"),
      msg("u3", "user", "new3"),
      msg("a3", "assistant", "reply3"),
    ], 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u2");
    expect(r.messages).toHaveLength(2);
    expect(r.keptUserTurns).toBe(2);
    expect(r.totalUserTurns).toBe(3);
  });
});

describe("buildOwnCut: entries normalize() cannot render", () => {
  // A host's role:"system" prompt/tool-loadout entry renders no block, and an
  // extension's custom_message can be skipped (skipCustomTypes). If one
  // becomes the cut boundary the summarized region carries no renderable
  // content: compile() returns "", the hook stores an empty summary while
  // keeping every message, context never shrinks, and the next agent_end
  // re-triggers compaction indefinitely.
  const customMsg = (id: string, content = "injected skill card text") => ({
    id,
    type: "custom_message",
    customType: "skill-card",
    content,
    display: true,
  });
  const singlePromptThenAutonomous = () => [
    sys("s1"),
    msg("m1", "user", "go"),
    msg("m2", "assistant", "calling tool"),
    msg("m3", "toolResult", "result"),
    msg("m4", "assistant", "more"),
    msg("m5", "toolResult", "result2"),
    msg("m6", "assistant", "done"),
  ];
  const withoutSystemEntry = () => singlePromptThenAutonomous().slice(1);

  test("system entry is not eligible as a cut boundary", () => {
    const r = buildOwnCut(singlePromptThenAutonomous());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).not.toBe("s1");
  });

  test("leading system entry does not change the cut decision", () => {
    const withSys = buildOwnCut(singlePromptThenAutonomous());
    const without = buildOwnCut(withoutSystemEntry());
    expect(withSys.ok).toBe(true);
    expect(without.ok).toBe(true);
    if (!withSys.ok || !without.ok) return;
    // Same decision: the system entry is not conversation content, so it must
    // not flip a compact-all into a split at the first user message.
    expect(withSys.compactAll).toBe(without.compactAll);
    expect(withSys.firstKeptEntryId).toBe(without.firstKeptEntryId);
    // The window itself still carries the entry (upstream keeps custom/
    // branch_summary in the summarizer input for the same reason).
    expect(withSys.messages).toHaveLength(without.messages.length + 1);
    for (const role of withSys.messages.map((m: any) => m.role)) {
      expect(["system", "user", "assistant", "toolResult"]).toContain(role);
    }
  });

  test("the summarized region always contains at least one renderable block", () => {
    const entries = singlePromptThenAutonomous();
    const r = buildOwnCut(entries);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cutIdx = entries.findIndex((e) => e.id === r.firstKeptEntryId);
    const summarized = r.compactAll ? entries : entries.slice(0, cutIdx);
    expect(summarized.length).toBeGreaterThan(0);
    const blocks = renderedBlocks(summarized.map((e: any) => e.message));
    expect(blocks.length).toBeGreaterThan(0);
  });

  test("a window of only system entries cancels instead of summarizing nothing", () => {
    const r = buildOwnCut([sys("s1"), sys("s2"), sys("s3")]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no_live_messages");
  });

  test("custom_message entry is not eligible as a cut boundary", () => {
    const r = buildOwnCut([
      customMsg("x1"),
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "done"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).not.toBe("x1");
    const blocks = renderedBlocks(r.messages);
    expect(blocks.length).toBeGreaterThan(0);
  });

  test("a trailing custom_message does not strand an empty summarized region", () => {
    const r = buildOwnCut([
      msg("m1", "user", "go"),
      msg("m2", "assistant", "a"),
      msg("m3", "toolResult", "r"),
      msg("m4", "assistant", "b"),
      customMsg("x1"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderedBlocks(r.messages).length).toBeGreaterThan(0);
  });

  test("a custom_message prefix renders, so the split at the first user message stays", () => {
    // convertToLlm turns custom_message into user content, so this prefix is not
    // empty. Treating it as unrenderable would needlessly switch to compact-all.
    const r = buildOwnCut([
      sys("s1"),
      customMsg("x1"),
      msg("m1", "user", "go"),
      msg("m2", "assistant", "a"),
      msg("m3", "toolResult", "r"),
      msg("m4", "assistant", "b"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("m1");
    expect(renderedBlocks(r.messages).length).toBeGreaterThan(0);
  });

  test("a custom_message listed in skipCustomTypes counts as unrenderable", () => {
    // The hook drops it before summarizing, so [system, skipped custom] is empty.
    const r = buildOwnCut(
      [sys("s1"), customMsg("x1"), msg("m1", "user", "go"), msg("m2", "assistant", "a"), msg("m3", "toolResult", "r"), msg("m4", "assistant", "b")],
      1,
      ["skill-card"],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
  });

  test("the budget re-cut never lands right after a lone system entry", () => {
    // The first user message alone exceeds the budget, so the budget boundary
    // falls at index 1, leaving [system] as the summarized prefix.
    const entries = [
      sys("s1"),
      msg("m1", "user", "x".repeat(4000)),
      msg("m2", "assistant", "a"),
      msg("m3", "toolResult", "r"),
      msg("m4", "assistant", "b"),
    ];
    const cut = buildOwnCut(entries);
    expect(cut.ok && cut.compactAll).toBe(true);
    const r = applyTailBudget(entries, cut, { maxTokens: 100, charsPerToken: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.budgetCut).toBeUndefined();
    expect(renderedBlocks(r.messages).length).toBeGreaterThan(0);
  });
});

describe("a user's !cmd output in the kept tail counts", () => {
  const bash = (id: string, output: string) => ({ id, type: "message", message: { role: "bashExecution", command: "cat build.log", output, exitCode: 0 } });
  const reply = (id: string, text: string) => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

  test("an oversized !cmd tail is cut to the token budget", () => {
    const entries = [msg("u1", "user", "set up the build"), reply("a1", "ok"), msg("u2", "user", "look at the log"), bash("b1", "x".repeat(300_000)), reply("a2", "it fails at step 3")];
    const cut = buildOwnCut(entries, 1);
    expect(cut).toMatchObject({ ok: true, firstKeptEntryId: "u2" });
    expect(applyTailBudget(entries, cut, { charsPerToken: 4 })).toMatchObject({ ok: true, budgetCut: "oversized_tail" });
  });

  test("smart keep does not grow keep:1 past a large !cmd tail", () => {
    const entries = [
      msg("u1", "user", "first request"), reply("a1", "ok"),
      msg("u2", "user", "second request"), reply("a2", "ok"),
      msg("u3", "user", "look at the log"), bash("b1", "x".repeat(100_000)), reply("a3", "it fails"),
    ];
    expect(resolveSmartKeepUserTurns({ branchEntries: entries, requestedKeepUserTurns: null, explicit: false, smartKeepTail: true, charsPerToken: 4 })).toMatchObject({ keepUserTurns: 1, smartAdjusted: false });
  });
});
