// How a summary is laid out (lisp/src/summary.lisp render-summary): the
// sections, then the brief after ---. A stored state rendered with nothing new.
import { describe, it, expect } from "bun:test";
import type { SummaryState } from "./support/compile";
import { summarize } from "./support/summary";

const empty: SummaryState = {
  earlyRequests: [],
  files: { modified: [], created: [], read: [] },
  commits: [],
  tracked: [],
  userMessages: [],
  brief: "",
  earlySlots: 0,
};

const formatSummary = (state: SummaryState): string => summarize({ messages: [] }, { previous: state }).text;

describe("the summary's layout", () => {
  it("returns empty string for all-empty sections", () => {
    expect(formatSummary(empty)).toBe("");
  });

  it("formats a single header section", () => {
    const data = {
      ...empty,
      earlyRequests: ["fix auth bug"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Early Session Requests]");
    expect(r).toContain("- fix auth bug");
  });

  it("separates header and brief transcript with ---", () => {
    const data = {
      ...empty,
      earlyRequests: ["goal"],
      brief: "[user]\ndo something",
    };
    expect(formatSummary(data)).toContain("[Early Session Requests]\n- goal\n\n---\n\n[user]\ndo something");
  });

  it("renders brief transcript alone when no header sections", () => {
    const data = {
      ...empty,
      brief: "[user]\nhi\n\n[assistant]\nhello",
    };
    expect(formatSummary(data)).toStartWith("[user]\nhi\n\n[assistant]\nhello\n\n---\n\n");
  });

  it("joins multiple header sections with blank line", () => {
    const data = {
      ...empty,
      earlyRequests: ["goal"],
      userMessages: ["next step"],
    };
    expect(formatSummary(data)).toStartWith("[Early Session Requests]\n- goal\n\n[User Messages]\n- next step\n\n---\n\n");
  });

  it("wraps long lines so compaction TUI rendering stays bounded", () => {
    // The brief is wrapped where it is made; the sections when they are written.
    const data = {
      ...empty,
      userMessages: ["word ".repeat(80).trim()],
    };
    const r = formatSummary(data);
    expect(Math.max(...r.split("\n").map((line) => line.length))).toBeLessThanOrEqual(120);
  });
});
