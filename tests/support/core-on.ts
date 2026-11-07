// Preloaded by bun test (bunfig.toml): every test runs on the core, built
// with the sbcl on PATH (or SBCL) as tests/support/lisp-core.ts builds it, unless
// the run names one in OMP_VCC_CORE. Without SBCL the tests that need the core
// fail with CoreUnavailable, which says what is missing: the core is omp-vcc.
import { lispCore } from "./lisp-core";

if (!process.env.OMP_VCC_CORE) {
  const built = lispCore();
  if (built) process.env.OMP_VCC_CORE = built;
}
