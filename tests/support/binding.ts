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
