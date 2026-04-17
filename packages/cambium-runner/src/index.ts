// Public entry point for @cambium/runner.
//
// RED-242 established the package boundary and moved the framework runtime
// into packages/cambium-runner/src/. A programmatic `runGen` API is not yet
// exposed — the CLI still launches runner.ts as a subprocess (see
// cli/cambium.mjs). RED-243 replaces the subprocess shape with a real
// library API (caller-injected schemas, runsRoot, etc.).
//
// Until then, this file exists so that `import { ... } from '@cambium/runner'`
// has a target and so the package's module graph is a real thing. Consumers
// importing from this package should wait for RED-243 to land.

export {};
