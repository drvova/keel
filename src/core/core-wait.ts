// What a surface does while omp-vcc's core is not there yet (being built, or
// no SBCL to build it): src/core/lisp-core.ts throws CoreUnavailable, whose
// message says why; a tool answers with it, a command tells it.
import { CoreUnavailable } from "./lisp-core";

/** `run`'s text, or why omp-vcc cannot answer yet. */
export const untilCore = (run: () => string): string => {
  try {
    return run();
  } catch (err) {
    if (err instanceof CoreUnavailable) return err.message;
    throw err;
  }
};

/** Run `run`; while the core is not there, hand its reason to `waiting` and give back undefined. */
export const whenCore = <T>(run: () => T, waiting: (why: string) => void = () => {}): T | undefined => {
  try {
    return run();
  } catch (err) {
    if (err instanceof CoreUnavailable) {
      waiting(err.message);
      return undefined;
    }
    throw err;
  }
};
