// Pi, as the Pi tests must see it: the real @earendil-works/pi-coding-agent.
//
// omp answers Pi's package names with its own package once omp is loaded in a
// process (its shim for Pi extensions running on omp), so a test file that runs
// after an omp test in the same process would import omp's copy and test
// nothing of Pi. The suite therefore runs each file in a fresh module registry
// (`bun run test`, which is `bun test --isolate`), and every Pi test checks it
// got the real Pi first (assertRealPi).
import { readFileSync } from "fs";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Where Pi's package.json resolves from here, or undefined when Pi is not installed. */
const resolvedPiManifest = (): string | undefined => {
  try {
    return Bun.resolveSync(`${PI_PACKAGE}/package.json`, import.meta.dir);
  } catch {
    return undefined;
  }
};

/** Pi is installed (`bun run setup:pi`). */
export const piInstalled = (): boolean => resolvedPiManifest() !== undefined;

/** Fail unless Pi's name resolves to Pi itself, not omp's shim for it. */
export const assertRealPi = (): void => {
  const manifest = resolvedPiManifest();
  if (!manifest) throw new Error(`${PI_PACKAGE} is not installed: bun run setup:pi`);
  const name = JSON.parse(readFileSync(manifest, "utf8")).name;
  if (name !== PI_PACKAGE) {
    throw new Error(
      `${PI_PACKAGE} resolves to ${name} here: omp, loaded earlier in this process, answers Pi's package names. ` +
        "Run the suite with --isolate (bun run test).",
    );
  }
};
