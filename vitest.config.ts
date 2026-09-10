import { defineConfig } from 'vitest/config'

// #244 CI incident (run 320): scope worker-pool size down for the Forgejo
// runner without touching local dev. `VITEST_MAX_WORKERS` is set only by
// .forgejo/workflows/unit-tests.yml (not the GitHub mirror — see that
// file's header for why it's Forgejo-only). Never set locally and never
// set by any other caller of `npm test`, so this branch is a no-op
// everywhere except that one CI job.
const ciMaxWorkers = process.env.VITEST_MAX_WORKERS
  ? Number(process.env.VITEST_MAX_WORKERS)
  : undefined;

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'packages/**/tests/**/*.test.ts'],
    // #244 CI incident (run 310): three tests that pass locally with ~5x
    // headroom on the 5000ms/10000ms vitest defaults (testTimeout/
    // hookTimeout) — WASM substrate instantiation in
    // exec-substrate/registry.test.ts and escape-tests.test.ts (~1s
    // locally), and the pipeline replay e2e case in
    // pipeline_runtime.test.ts (~0.8s locally) — timed out on the Forgejo
    // runner. That runner is `nas-pi`, a Raspberry Pi shared with other
    // CI jobs; a several-times slowdown for WASM module instantiation and
    // subprocess-spawning e2e tests there is expected, not a regression.
    // One global bump (rather than per-test `{ timeout: N }` overrides)
    // because the next slow test on the same Pi would just fail the same
    // way — the hardware is the constraint, not any one test. 30s gives
    // ~30x the slowest observed local case and ~6x the vitest default;
    // don't "tidy" this back down without re-measuring on the Pi runner
    // itself, not on a dev machine.
    testTimeout: 30000,
    hookTimeout: 30000,
    // #244 CI incident (runs 320 + 323): after the testTimeout fix above
    // landed, the job still failed with ZERO test failures. The failure is
    // vitest's own worker->main "onTaskUpdate" progress RPC timing out, and
    // vitest exits non-zero on any unhandled error regardless of test
    // results (runs 320 and 323: 2258 passed, 0 failed, exit 1).
    //
    // Mechanism, read out of the installed vitest 3.2.7 (do not re-derive
    // this from the error text alone — several plausible readings are
    // wrong, see below). The main side of that RPC is:
    //
    //     for (const [id, event, data] of events)
    //       await this.reportEvent(id, event, data)
    //     await this.vitest.report("onTaskUpdate", update, events)
    //
    // i.e. the reply is sent only after every reporter has finished,
    // serially, on the single main event loop that every worker's updates
    // funnel through. Behind that sits a HARDCODED 60s birpc timeout
    // (`DEFAULT_TIMEOUT = 6e4`) that vitest does not expose under `test:`.
    // An unbounded-latency path behind a fixed deadline; on a slow, shared
    // ARM board it eventually loses. 3.2.7 is the newest 3.x, so there is
    // no patch release to take — only a 4.x major bump.
    //
    // Falsified hypotheses, each with its evidence, so nobody re-runs them:
    //   - Memory or IO pressure on the runner. Measured, not assumed: the
    //     "Runner resources" step reports 16214 MB total / 13671 MB
    //     available with 1 MB of 2047 MB swap touched. The box is not
    //     short of memory. (This was the leading hypothesis while the
    //     hardware was unknown; the diagnostics step exists because it
    //     was wrong.)
    //   - Two workers being few enough. `VITEST_MAX_WORKERS: '2'` took
    //     effect in run 323 (summed test time 433s -> 323s) and the error
    //     still fired. The cap was right; the number wasn't.
    //   - A worker wedged in a long synchronous `spawnSync`. The slowest
    //     single test on the Pi is 4.5s; nothing blocks near 60s.
    //   - `pool: 'forks'` as a lever. vitest 3.2.7 ALREADY defaults to
    //     forks; there is no thread pool to switch away from.
    //   - Fake timers corrupting the RPC's captured timer. The suite uses
    //     `useFakeTimers` nowhere.
    //   - Reporter output volume (i.e. raising `slowTestThreshold`). The Pi
    //     printed 190 slow-test lines vs 110 locally — 1.7x, spread over
    //     198s. Not the bottleneck.
    //   - The end-of-log burst of fast files being a drained backlog. It
    //     isn't: `prepare + collect` over 162 files is ~230ms/file of
    //     ordinary per-file setup, and vitest prints unhandled errors in
    //     the END-OF-RUN summary, so the error's log timestamp is when it
    //     was reported, not when it was thrown.
    //
    // What `ciMaxWorkers` is for, then: CPU oversubscription, counting
    // what the tests THEMSELVES spawn. The runner has 4 cores (aarch64).
    // Most of this suite's slow tests shell out to `cambium run`, so each
    // vitest worker is really a worker plus a node subprocess plus a ruby
    // one; at 2 workers that is ~5-7 runnable processes on 4 cores, with
    // vitest's main loop — the thing that has to answer the RPC inside
    // 60s — just one more of them. `'1'` was green on run 326, and the
    // summed test time FELL to 251.60s from 323s at two workers, which is
    // the signature of contention removed rather than work deferred.
    // Counting only vitest's own workers against nproc undercounts the
    // load by roughly 3x; that is the trap this comment exists to flag.
    //
    // Still empirical rather than fully diagnosed: what is proven is that
    // the failure is load-dependent and that 1 worker clears it, not the
    // precise path by which a reporter batch blew 60s.
    maxWorkers: ciMaxWorkers,
  },
})
