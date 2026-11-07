// Preloaded by bun test (bunfig.toml): every test runs on the core, built
// with the sbcl on PATH (or SBCL) as tests/support/lisp-core.ts builds it, unless
// the run names one in OMP_VCC_CORE. Without SBCL the core is off and the tests
// that need it fail, saying so (they are omp-vcc's behaviour now).
import { lispCore } from "./lisp-core";

if (!process.env.OMP_VCC_CORE) process.env.OMP_VCC_CORE = lispCore() ?? "off";
