import { beforeAll, describe, expect, it } from "bun:test";
import { assertRealPi, piInstalled } from "./support/pi";
import { existsSync } from "node:fs";
import { buildCompactReport } from "../src/core/report";
import { prepareSessionSamples, readSourceStat, sessionRoot, type SessionSample } from "./support/real-sessions";
import { loadPiSessionMessages, loadSessionMessages } from "./support/load-session";

// Integration test against real session transcripts, for each host whose
// sessions exist here (~/.omp/agent/sessions, ~/.pi/agent/sessions, read with
// that host's own parser) — skipped where none do (CI runners) instead of
// failing on ENOENT. The guard must live in beforeAll too: file-scope hooks run
// even when the describe below is skipped.
const HOSTS = [
  { host: "omp" as const, present: existsSync(sessionRoot("omp")), load: async (file: string) => loadSessionMessages(file) },
  { host: "pi" as const, present: existsSync(sessionRoot("pi")) && piInstalled(), load: loadPiSessionMessages },
];

for (const { host, present, load } of HOSTS) {
  let samples: SessionSample[] = [];

  beforeAll(async () => {
    if (present && host === "pi") assertRealPi();
    if (present) samples = await prepareSessionSamples(2, host);
  });

  describe.if(present)(`real session integration (${host})`, () => {
    it("compiles copied large sessions without mutating originals", async () => {
      for (const sample of samples) {
        const before = await readSourceStat(sample);
        const loaded = await load(sample.copy);
        const report = buildCompactReport({ messages: loaded.messages });
        const after = await readSourceStat(sample);

        expect(loaded.messageCount).toBeGreaterThan(0);
        expect(loaded.skippedCount).toBeGreaterThanOrEqual(0);
        expect(report.summary.length).toBeGreaterThan(0);
        expect(report.summary).toContain("[");
        expect(report.before.preview.length).toBeGreaterThan(0);
        expect(report.after.summaryPreview.length).toBeGreaterThan(0);
        expect(report.compression.charsBefore).toBeGreaterThan(0);
        expect(report.recall.probes.length).toBeGreaterThan(0);
        expect(after).toEqual(before);
      }
    });

    it("uses read-only copied fixtures", () => {
      for (const sample of samples) {
        expect(sample.copy).not.toBe(sample.source);
        expect(sample.copy.includes("omp-vcc-sessions-")).toBe(true);
      }
    });
  });
}
