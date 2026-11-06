// A binding's config for tests: OMP_VCC_CONFIG_PATH when a test sets it, else a
// file under the temp dir, never the user's. Imports no host package.
import { tmpdir } from "os";
import { join } from "path";
import { openConfig } from "../../src/core/settings";
import { OMP_HOST, PI_HOST } from "../../src/host";

export const testConfig = openConfig(() => join(tmpdir(), "omp-vcc-test-agent"));

/** omp's and Pi's profiles with that config, for what reads only those (the recall tool and command). */
export const ompBinding = { ...OMP_HOST, config: testConfig };
export const piBinding = { ...PI_HOST, config: testConfig };
