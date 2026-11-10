// KEEL_REPLAY_OUT: every core call recorded as one JSON line (the request and
// what the core said, or why it failed), the sequence lisp/keel-replay.el
// steps through (src/core.ts tapReplay). Recording is off unless named, and
// never breaks the call.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { core } from "../src/core";

/** Where keel keeps one core for every request: src/core.ts's liveWanted. */
const LIVE = process.platform !== "win32";

const lines = (file: string): any[] =>
  readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("KEEL_REPLAY_OUT", () => {
  it("records the request and its response, on the live core and on a process of its own", () => {
    const file = join(mkdtempSync(join(tmpdir(), "keel-replay-")), "r.jsonl");
    process.env.KEEL_REPLAY_OUT = file;
    try {
      const live = LIVE ? core({ op: "names" }) : undefined;
      process.env.KEEL_CORE_LIVE = "off";
      try {
        const alone = core({ op: "surface" });
        expect(alone.ok).toBe(true);
      } finally {
        delete process.env.KEEL_CORE_LIVE;
      }
      const recs = lines(file);
      expect(recs.length).toBe(LIVE ? 2 : 1);
      expect(recs[0].request).toEqual({ op: "names" });
      expect(recs[0].response.ok).toBe(true);
      expect(recs[0].response.names.pinEntryType).toBe("keel.pin");
      if (LIVE) {
        expect(live!.ok).toBe(true);
        expect(recs[1].request).toEqual({ op: "surface" });
        expect(recs[1].response.ok).toBe(true);
        expect(recs[1].response.surface.tools.length).toBeGreaterThan(0);
      }
    } finally {
      delete process.env.KEEL_REPLAY_OUT;
    }
  });

  it("records a core failure without breaking the throw", () => {
    const file = join(mkdtempSync(join(tmpdir(), "keel-replay-")), "r.jsonl");
    process.env.KEEL_REPLAY_OUT = file;
    try {
      expect(() => core({ op: "bogus" })).toThrow("unknown op");
      const recs = lines(file);
      expect(recs.length).toBe(1);
      expect(recs[0].request).toEqual({ op: "bogus" });
      expect(recs[0].response).toBeNull();
      expect(recs[0].error).toMatch("unknown op");
    } finally {
      delete process.env.KEEL_REPLAY_OUT;
    }
  });

  it("records nothing unless named", () => {
    const file = join(mkdtempSync(join(tmpdir(), "keel-replay-")), "r.jsonl");
    expect(core({ op: "names" }).ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});
