// A recorded session on each real host (tests/support/golden-session.ts):
// every summary, its details and recall outputs, compared byte for byte with
// tests/fixtures/golden-<host>.json. A change to what omp-vcc writes or recall
// says shows here; record it again on purpose:
//   bun run tests/support/golden-session.ts omp > tests/fixtures/golden-omp.json
//   bun run tests/support/golden-session.ts pi > tests/fixtures/golden-pi.json
// Each skips where its host is not installed.
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const installed = {
  omp: existsSync(join(REPO, "node_modules/@oh-my-pi/pi-coding-agent/src/index.ts")),
  pi: existsSync(join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")),
};

describe("a recorded session", () => {
  for (const host of ["omp", "pi"] as const) {
    it.skipIf(!installed[host])(`on ${host} writes the summaries and recall outputs recorded for it`, () => {
      const run = spawnSync(process.execPath, ["run", join(REPO, "tests/support/golden-session.ts"), host], { encoding: "utf8", maxBuffer: 1 << 28 });
      expect(run.status).toBe(0);
      const got = JSON.parse(run.stdout);
      const want = JSON.parse(readFileSync(join(REPO, `tests/fixtures/golden-${host}.json`), "utf8"));
      // Section by section, so a failure names what changed.
      expect(got.compactions.map((c: any) => c.label)).toEqual(want.compactions.map((c: any) => c.label));
      got.compactions.forEach((c: any, i: number) => expect({ label: c.label, ...c }).toEqual({ label: c.label, ...want.compactions[i] }));
      for (const k of Object.keys(want.recall)) expect({ k, text: got.recall[k] }).toEqual({ k, text: want.recall[k] });
      expect(got.notices).toEqual(want.notices);
    }, 120_000);
  }
});
