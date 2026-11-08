// The live core: one core process answering every request (lisp/src/live.lisp,
// src/core.ts), with what it read kept for the next request. It must
// answer as a process per request does, also after the file it read grew or
// was rewritten, and a core that dies is replaced without the caller noticing.
import { describe, expect, it } from "bun:test";
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { core, liveCorePid } from "../src/core";
import { freshDir, writeJsonl } from "./support/session-files";

const entries = (n: number, word = "alpha") => {
  const out: unknown[] = [{ type: "session", id: "s", cwd: "/x" }];
  for (let i = 0; i < n; i++) {
    out.push({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `${word} entry ${i}` }] } });
  }
  return out;
};

/** The same request answered by the live core and by a process of its own. */
const both = (request: object) => {
  const live = core(request);
  process.env.KEEL_CORE_LIVE = "off";
  try { return { live, alone: core(request) }; } finally { delete process.env.KEEL_CORE_LIVE; }
};

describe("the live core", () => {
  it("answers as a process per request does, as the file it read grows and is rewritten", () => {
    const file = join(freshDir(), "s.jsonl");
    writeJsonl(file, entries(6));
    const search = { op: "search", file, query: "alpha entry" };
    let { live, alone } = both(search);
    expect(liveCorePid()).toBeNumber();
    expect(live).toEqual(alone);
    // What was worked out of the file for one query (its rendering, its folded text) serves the next.
    for (const query of ["entry 3", "alpha", "entry"]) {
      ({ live, alone } = both({ ...search, query }));
      expect(live).toEqual(alone);
    }
    // Grown: only the new line is read, and it is found.
    appendFileSync(file, JSON.stringify({ type: "message", id: "z", parentId: "e5", message: { role: "user", content: "alpha appended" } }) + "\n");
    ({ live, alone } = both({ ...search, query: "appended" }));
    expect(live).toEqual(alone);
    expect((live.hits as unknown[]).length).toBe(1);
    // Rewritten in place, as omp blanks a result: read again whole.
    writeJsonl(file, entries(6, "beta"));
    ({ live, alone } = both({ ...search, query: "alpha" }));
    expect(live).toEqual(alone);
    expect(live.hits).toEqual([]);
  });

  it("is replaced when it dies, and the request is still answered", () => {
    core({ op: "regex", pattern: "a", texts: ["a"] });
    const pid = liveCorePid()!;
    process.kill(pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    expect(core({ op: "regex", pattern: "b+", texts: ["abbc"] }).results).toEqual([{ test: true, search: 1, count: 1 }]);
    core({ op: "regex", pattern: "a", texts: ["a"] });
    expect(liveCorePid()).toBeNumber();
    expect(liveCorePid()).not.toBe(pid);
  });

  it("reports a failed request as failed, and keeps serving", () => {
    expect(() => core({ op: "nope" })).toThrow('keel\'s core failed: unknown op "nope"');
    const pid = liveCorePid();
    expect(core({ op: "regex", pattern: "x", texts: ["y"] }).results).toEqual([{ test: false, search: -1, count: 0 }]);
    expect(liveCorePid()).toBe(pid);
  });

  it("is not used with KEEL_CORE_LIVE=off", () => {
    core({ op: "regex", pattern: "a", texts: ["a"] });
    const pid = liveCorePid()!;
    process.kill(pid, "SIGKILL");
    process.env.KEEL_CORE_LIVE = "off";
    try {
      const file = join(freshDir(), "t.jsonl");
      writeFileSync(file, "");
      expect(core({ op: "search", file, query: "q" }).hits).toEqual([]);
      // Answered by a process of its own: the dead live core was not even looked at.
      expect(liveCorePid()).toBe(pid);
    } finally { delete process.env.KEEL_CORE_LIVE; }
  });
});
