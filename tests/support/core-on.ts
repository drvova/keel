// Preloaded by bun test (bunfig.toml): every test runs on the core, the build
// of this copy's sources that omp-vcc itself makes (src/core/lisp-core.ts),
// built now with the sbcl on PATH (or SBCL), unless the run names one in
// OMP_VCC_CORE. Without SBCL the tests that need the core fail with
// CoreUnavailable, which says what is missing: the core is omp-vcc.
import { buildCoreNow } from "../../src/core/lisp-core";

if (!process.env.OMP_VCC_CORE) {
  const built = buildCoreNow();
  if (built) process.env.OMP_VCC_CORE = built;
}
