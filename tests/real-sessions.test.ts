import { beforeAll, describe, expect, it } from "bun:test";
import { assertRealPi, piInstalled } from "./support/pi";
import { existsSync, readdirSync } from "node:fs";
import { buildCompactReport } from "./support/report";
import { prepareSessionSamples, sessionRoot, type SessionSample } from "./support/real-sessions";
import { loadPiSessionMessages, loadSessionMessages } from "./support/load-session";

// Integration test against real session transcripts, for each host whose
// sessions exist here (~/.omp/agent/sessions, ~/.pi/agent/sessions, read with
// that host's own parser) — skipped where none do (CI runners) instead of
// failing on ENOENT. The guard must live in beforeAll too: file-scope hooks run
// even when the describe below is skipped.
const hasSessions = (root: string): boolean =>
  existsSync(root) && readdirSync(root, { recursive: true }).some((name) => String(name).endsWith(".jsonl"));
const HOSTS = [
  { host: "omp" as const, present: hasSessions(sessionRoot("omp")), load: async (file: string) => loadSessionMessages(file) },
  { host: "pi" as const, present: hasSessions(sessionRoot("pi")) && piInstalled(), load: loadPiSessionMessages },
];

for (const { host, present, load } of HOSTS) {
  let samples: SessionSample[] = [];

  beforeAll(async () => {
    if (present && host === "pi") assertRealPi();
    if (present) samples = await prepareSessionSamples(2, host);
  });

  describe.if(present)(`real session integration (${host})`, () => {
    // Read from copies (prepareSessionSamples), so a session the host is writing to now is never touched.
    it("compiles the largest sessions into a summary", async () => {
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        const loaded = await load(sample.copy);
        const report = buildCompactReport({ messages: loaded.messages });

        expect(loaded.messageCount).toBeGreaterThan(0);
        expect(report.summary.length).toBeGreaterThan(0);
        expect(report.summary).toContain("[");
        expect(report.compression.charsBefore).toBeGreaterThan(0);
        expect(report.recall.probes.length).toBeGreaterThan(0);
      }
    });
  });
}
