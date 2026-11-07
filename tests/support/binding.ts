// A binding's config for tests: OMP_VCC_CONFIG_PATH when a test sets it, else a
// file under the temp dir, never the user's. Imports no host package.
import { tmpdir } from "os";
import { join } from "path";
import { openConfig } from "../../src/core/settings";
import { bind, OMP_HOST, PI_HOST } from "../../src/host";

export const testConfig = openConfig(() => join(tmpdir(), "omp-vcc-test-agent"));

/** omp's and Pi's profiles with that config, for what reads only those (the recall tool and command). */
export const ompBinding = bind(OMP_HOST, testConfig);
export const piBinding = bind(PI_HOST, testConfig);

/** One vcc_recall call on omp's binding, the model's window `contextWindow` when one is given. */
export const executeRecall = (params: unknown, sessionManager: any, options: { contextWindow?: number } = {}): string => {
  const { recall } = require("../../src/core/recall-run") as typeof import("../../src/core/recall-run");
  return recall(ompBinding, { sessionManager, model: options.contextWindow ? { contextWindow: options.contextWindow } : null }, { surface: "tool", params }).text;
};

/** One vcc_pin call on omp's binding, appended through `host`. */
export const executePin = (params: unknown, host: { appendEntry: (customType: string, data?: unknown) => void }, sessionManager: any): string => {
  const { pin } = require("../../src/core/pins") as typeof import("../../src/core/pins");
  return pin(host, ompBinding, { sessionManager }, { surface: "tool", params: params ?? null }).text;
};
