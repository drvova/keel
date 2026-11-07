// Preloaded by bun test (bunfig.toml): with OMP_VCC_CORE unset, omp-vcc would
// build its core on first use and switch to it mid-run; a test run says which it tests.
process.env.OMP_VCC_CORE ??= "off";
