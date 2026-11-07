// omp-vcc's names and the limits its tools state are the core's
// (lisp/src/names.lisp); src/names.ts copies them for the tool descriptions,
// which are written before a core may exist. The copy must say what the core does.
import { describe, expect, it } from "bun:test";
import { core } from "../src/core/lisp-core";
import * as names from "../src/names";

describe("src/names.ts", () => {
  it("says what the core's names and limits are", () => {
    expect(core({ op: "names" }).names).toMatchObject({
      recallTool: names.RECALL_TOOL,
      recallParams: [...names.RECALL_PARAMS],
      pinTool: names.PIN_TOOL,
      pinParams: [...names.PIN_PARAMS],
      pinEntryType: names.PIN_ENTRY_TYPE,
      contextTool: names.CONTEXT_TOOL,
      contextParams: [...names.CONTEXT_PARAMS],
      evictEntryType: names.EVICT_ENTRY_TYPE,
      pinNoticeType: names.PIN_NOTICE_TYPE,
      budgetNoticeType: names.BUDGET_NOTICE_TYPE,
      recallCommandMessageType: names.RECALL_COMMAND_MESSAGE_TYPE,
      searchPageSize: names.SEARCH_PAGE_SIZE,
      rangePageSize: names.RANGE_PAGE_SIZE,
      recallOutputChars: names.RECALL_OUTPUT_CHARS,
      pinChars: names.PIN_CHARS,
      evictAtPercent: names.EVICT_AT_PERCENT,
      contextNoteChars: names.CONTEXT_NOTE_CHARS,
      sessionRefMinChars: names.SESSION_REF_MIN_CHARS,
    });
  });
});
