import { describe, it, expect } from "bun:test";
import { renderSummary } from "../src/core/format";
import type { SummaryState } from "../src/core/summary-state";
import { DEFAULT_SUMMARY_LIMITS } from "../src/core/window";

const empty: SummaryState = {
  earlyRequests: [],
  files: { modified: [], created: [], read: [] },
  commits: [],
  tracked: [],
  userMessages: [],
  brief: "",
};

const formatSummary = (state: SummaryState): string => renderSummary({ state, limits: DEFAULT_SUMMARY_LIMITS }).text;

describe("renderSummary", () => {
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
    const r = formatSummary(data);
    expect(r).toContain("[Early Session Requests]");
    expect(r).toContain("---");
    expect(r).toContain("[user]\ndo something");
  });

  it("renders brief transcript alone when no header sections", () => {
    const data = {
      ...empty,
      brief: "[user]\nhi\n\n[assistant]\nhello",
    };
    const r = formatSummary(data);
    expect(r).toContain("[user]\nhi\n\n[assistant]\nhello");
  });

  it("joins multiple header sections with blank line", () => {
    const data = {
      ...empty,
      earlyRequests: ["goal"],
      userMessages: ["next step"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Early Session Requests]");
    expect(r).toContain("[User Messages]");
    expect(r).toContain("\n\n");
  });

  it("wraps long lines so compaction TUI rendering stays bounded", () => {
    // The brief is wrapped where it is made (freshState); the sections here.
    const data = {
      ...empty,
      userMessages: ["word ".repeat(80).trim()],
    };
    const r = formatSummary(data);
    expect(Math.max(...r.split("\n").map((line) => line.length))).toBeLessThanOrEqual(120);
  });
});
