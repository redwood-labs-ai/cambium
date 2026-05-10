# Runtime: Serve Mode

**Doc ID:** gen-dsl/runtime/serve-mode

## Purpose

Run Cambium as a long-lived HTTP server hosting every gen in a workspace. The transport layer for non-Node hosts (FastAPI, Django, Flask, Go, Elixir, Rails) — anything that speaks HTTP + JSON can call into Cambium without reimplementing the runtime or paying per-request Node startup.

Serve mode is **transport, not new runtime**. Every invariant the runner enforces in single-shot mode (RED-137 dispatch + SSRF guard, RED-275/298/299 corrector loops, RED-258/259 substrate plumbing, RED-215 memory pool authority) holds unchanged — the HTTP server is a thin shell over `runGenFromIr` from `@redwood-labs/cambium-runner`.

## Forcing case

A FastAPI service consuming six Cambium gens on the request path. Each `POST /api/<gen>` shells out to `cambium run`, paying ~1.5 s of Node startup + ~300 ms of provider-client warmup *per request* before the model is invoked. p50 ≈ 2.5 s when the actual model work is 600 ms — the difference between snappy and visibly slow.

Generalizes immediately: any web service or job runner that wants warm Cambium without a Node bridge; notebooks doing repeated calls; anything that benefits from model-client connection reuse and Anthropic prompt-cache hits across requests.

## CLI

```bash
cambium serve --workspace <path> --bind <uri> [flags]

# Flags
--workspace <path>     Path to the workspace containing Genfile.toml. Defaults to ".".
--bind <uri>           Bind address (required). One of:
                         tcp://127.0.0.1:9000
                         unix:///tmp/cambium.sock
                         pipe://cambium                (Windows named pipe)
--allow-remote         Allow non-loopback tcp:// binds. The runner is unauthenticated
                       in v1; only pass when the orchestrator isolates the address.
--max-inflight <n>     Cap concurrent /v1/run dispatches; over-cap → 503 + overloaded.
                       Defaults to unlimited.
--run-timeout <s>      Per-call deadline. /v1/run that misses it → 504 + timeout.
                       Frees the inflight slot but does NOT cancel the underlying run.
                       Defaults to unlimited.
--shutdown-timeout <s> SIGTERM/SIGINT drain deadline. After this, lingering
                       connections are force-closed. Defaults to 30s.
```

## Wire format (locked at v1)

`POST /v1/run`:

```json
{
  "gen": "ResumeParser",
  "method": "analyze",
  "input": "<string | object | array>",
  "memory_keys": { "user_id": "abc" },
  "fired_by": "schedule:<id>",
  "include_trace": false
}
```

Success response (200):

```json
{
  "ok": true,
  "run_id": "run_20260510_...",
  "output": { "...": "..." },
  "warnings": [
    { "kind": "CorrectAcceptedWithErrors", "corrector": "regex_x", "issues": [...] }
  ],
  "trace": null
}
```

Failure response:

```json
{
  "ok": false,
  "run_id": "run_20260510_...",
  "error": {
    "kind": "validation_failed",
    "message": "schema validation exhausted after 3 repair attempts",
    "details": { "...": "..." }
  }
}
```

`run_id` is surfaced even on failure so callers can correlate with the on-disk trace at `<workspace>/runs/<run_id>/trace.json`. `include_trace: true` additionally returns the trace JSON inline.

`GET /v1/healthz`:

```http
GET /v1/healthz
→ 200 { "status": "ok", "gens": ["ResumeParser", ...], "version": "v1" }
→ 503 { "ok": false, "error": { "kind": "booting", ... } }    while pre-compile is running
```

`/v1/healthz` is **never** rate-limited or gated by `--max-inflight` — orchestrators have to be able to probe a saturated server.

### Versioning

The `/v1/` prefix is locked from the first release. Breaking wire-format changes go to `/v2/`. Additive response fields are NOT breaking — clients MUST ignore unknown fields. Renaming a field, removing one, or narrowing an enum IS breaking.

### error.kind enum (closed in v1)

| Kind | HTTP | When |
| -- | -- | -- |
| `unknown_gen` | 400 | gen name not in catalog |
| `unknown_method` | 400 | gen exists, method does not |
| `input_invalid` | 400 | malformed JSON, missing `gen` / `method`, oversize body |
| `validation_failed` | 500 | schema validation exhausted after repair attempts |
| `budget_exhausted` | 500 | `BudgetExceededError` caught by runGen |
| `tool_dispatch_failed` | 400 | unknown tool, unknown action, security violation (pre-flight) |
| `runner_error` | 500 | other runtime failures (document extraction, unexpected) |
| `timeout` | 504 | `--run-timeout` deadline missed |
| `overloaded` | 503 | `--max-inflight` cap hit |
| `booting` | 503 | server still pre-compiling at boot |
| `not_found` | 404 | unknown route |

Adding a new kind is a v2 break. The Python client (`cambium-client`) maps each 1:1 to an exception subclass.

## Bind URI taxonomy

| Scheme | Form | Platforms |
| -- | -- | -- |
| `tcp://` | `tcp://host:port` (v6 in brackets: `tcp://[::1]:9000`) | All. |
| `unix://` | `unix:///abs/path` | Mac, Linux, Windows 10+ (AF_UNIX). |
| `pipe://` | `pipe://name` → `\\.\pipe\<name>` | Windows. |

Loopback enforcement: `tcp://` non-loopback hosts are refused without `--allow-remote`. The loopback set is `localhost`, `127.0.0.0/8`, `::1` (and the explicit-form IPv6 loopback). Everything else (`0.0.0.0`, `::`, RFC-1918 private ranges, public IPs, hostnames not in the set) is "remote" and requires the explicit opt-in.

The runner is **unauthenticated in v1**. The only thing standing between an open bind and the public internet is this guard plus the orchestrator's network isolation. Belt-and-suspenders.

Port `0` is allowed and means "OS picks a free port" — useful for tests; the actual port surfaces in the `RunServeAddress` returned by `handle.ready`.

## Lifecycle

```
boot:
  1. Load Genfile.toml → validate [exports.gens] shape (PascalCase keys,
     relative-and-inside-workspace paths, files exist on disk).
  2. For each gen, spawn `ruby compile.rb <path>` in bare mode. The Ruby
     compiler emits a {method → IR} map for every public user method on
     the GenModel; the server caches them all.
  3. Bind the HTTP listener (parseBind) and resolve `handle.ready`.

per-request:
  /v1/run:
    a. validate body (`gen`, `method` strings; `input` JSON-coercible).
    b. look up cached IR by (gen, method); 400 with unknown_gen /
       unknown_method on miss.
    c. clone IR, inject `body.input` into ir.context.<source>.
    d. dispatch via runGenFromIr (cwd = workspaceDir, so `runs/`
       artifacts land under the workspace).
    e. map result.failureKind → wire error.kind; serialize JSON.
  /v1/healthz: return catalog (or booting if pre-compile still running).
  other: 404 + not_found.

shutdown (SIGTERM/SIGINT):
  1. Stop accepting new connections.
  2. Wait on inflight handlers + server.close() up to --shutdown-timeout.
  3. On deadline: server.closeAllConnections() to force-close lingering
     sockets so close() resolves promptly.
  4. Process exits cleanly.
```

Crash recovery = container restart. The runner does not attempt to resume in-flight runs — RED-241's "no new primitive" stance plus the existing scheduled-fire model already cover the cases that need it.

## Compile-at-boot via `compile.rb` bare mode

Ruby `compile.rb` accepts a no-`--method` form that emits a JSON map of every public user method's IR (RED-360). Serve mode boots by calling this once per gen; the compile cost (~50–100 ms per gen) is paid at startup, not per request.

Single-method gens still get a 1-entry map (always-map shape, never bare IR). With `--method X`, behavior is unchanged: emit a single IR. Existing engine-mode build steps that already pass `--method` keep working bit-for-bit.

## Boot fail-fast

If ANY `[exports.gens]` entry fails to compile (Ruby syntax error, missing referenced schema, etc.), the server fails to start with a clear error. Half-loaded servers — where some gens work and others fail at first request — are NOT a state the runtime allows. Operators see compile errors at boot, not as 500s in production traffic.

## Concurrency

Node is single-threaded but `runGen` is async throughout — N concurrent calls share the event loop. Provider rate limits remain the bottleneck; `--max-inflight` is the *server-side* cap (returns 503 + `overloaded` when full).

`--max-inflight` defensively treats `0` and negative values as "unlimited" rather than "block everything," so a misconfigured operator can't permanently brick the server.

## Per-call deadline

`--run-timeout <seconds>` races each `/v1/run` against a deadline. On timeout the server returns 504 + `error.kind=timeout` and **frees the inflight slot immediately** — the underlying `runGen` call continues in the background (the runner has no cooperative cancellation in v1) but its result is dropped.

Important interaction: timeout decrementing the inflight counter is what prevents a slow-but-not-cancellable gen from permanently exhausting `--max-inflight`. The leaked promise's eventual resolution is `.catch`d so a post-timeout rejection doesn't surface as an unhandled rejection.

Caveat for operators: a misbehaving long-running gen still burns model spend after the timeout fires. Cooperative cancellation is a future runtime concern.

## Trace artifacts

Per-call artifacts land at `<workspace>/runs/<run_id>/{ir.json,trace.json,output.json}` — exactly the same on-disk contract as `cambium run`. Set `include_trace: true` in the request body to additionally return the trace inline (read from disk after the run completes); the run_id always lets the caller fetch the trace separately.

Run-id format is `run_<UTC>_<rand>` (matches `runGenFromIr`'s existing scheme).

## Polyglot client surface

The wire format is the contract; clients are thin. The Cambium monorepo's first-party Python client is RED-361 (Phase 2 of the Serve Mode work) — `pip install cambium-client`, sync + async, `httpx`-based, exception subclass per `error.kind`. Other languages can hit the HTTP API directly.

## Architecture

```
packages/cambium-runner/src/serve/
  bind.ts          # URI parser (tcp/unix/pipe) + loopback enforcement
  bind.test.ts
  gen-catalog.ts   # Genfile.toml [exports.gens] loader + path validation
  gen-catalog.test.ts
  serve.ts         # node:http server, runGen dispatch, error mapping
  serve.test.ts    # 32 e2e + unit tests covering happy + every error.kind

cli/
  serve.mjs        # argv parsing, runServe, SIGTERM/SIGINT drain
  cambium.mjs      # cambium serve case in main switch
```

The runner package's public surface includes `runServe`, `parseBind`, `RunServeOptions`, `RunServeHandle`, and the `BindTarget` / `ErrorKind` type aliases — engine-mode hosts that want to embed the server have the same entry point as the CLI.

## Out of scope (v1)

These are documented non-goals, not "not yet built." Each is a deliberate choice with reasoning:

- **Authentication.** No bearer tokens, mTLS, OIDC, or anything stronger than network isolation. Operators run serve mode behind a trusted Docker network or on loopback. Cross-host hosting needs a real auth design and is a v1.5 conversation.
- **Hot-reload of gen files.** Operators bounce the process. A `--watch` flag is quality-of-life, not correctness.
- **Multi-workspace per server.** One server, one workspace. Run multiple if needed.
- **Streaming traces.** HTTP request/response only in v1. SSE/WebSocket is v1.5+ for observability dashboards.
- **Run cancellation.** No `DELETE /v1/runs/<id>` endpoint; the runner has no cooperative cancellation. `--run-timeout` is a timeout, not a cancel.
- **Cross-host TLS.** Operators terminate at a reverse proxy if needed.
- **Embedding the runner inside Python via FFI / PyO3.** Would split the implementation — every Cambium invariant becomes a two-language audit. Serve mode is the answer.
- **Distributed tracing across multiple `cambium serve` instances.** Per-server traces only.
- **Resource quotas (per-caller, per-IP, per-tenant).** Orchestrator's job, not the runner's.

## Deferred (post-v1, not non-goals)

Items the original RFC said we'd ship but that didn't pull their weight on closer inspection:

- **Memory handle pool.** The original RFC posited an LRU pool for SQLite handles to keep a long-lived process from accumulating file descriptors. On closer reading: the existing `runGen` lifecycle already opens handles in `readMemoryForRun` and closes them via `closeBackends` at end-of-run, so handles do **not** accumulate across `runGen` calls. A pool would be a performance optimization (~1–5 ms saved per call), not a correctness fix. Without measured pressure showing per-call open cost is a bottleneck, building the pool is premature optimization. Revisit when real serve-mode traffic shows where the cost actually hurts; cache shape stays compatible (Map keyed by bucket path) so the addition is non-disruptive.

## See also

- [[C - Runner (TS runtime)]] — the runtime serve mode wraps unchanged.
- [[C - IR (Intermediate Representation)]] — the cache contents.
- [[C - Trace (observability)]] — the trace shape `include_trace` returns inline.
- [[D - Packages & Workspaces (Scale-Invariant)]] — `[exports.gens]` is the gen catalog serve mode preloads.
- [[S - Tool Sandboxing (RED-137)]] — the dispatch invariants serve mode does NOT relitigate.
- [[N - App Mode vs Engine Mode (RED-220)]] — engine-mode embedding context this builds on.
- [[N - Engine-Mode Corrector Registry Isolation (RED-281)]] — per-`runGen` isolation that makes serve mode's "many calls, one process" safe.
