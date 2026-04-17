## Note: Tool Exec Sandboxing

**Doc ID:** gen-dsl/security/exec-sandboxing
**Status:** Draft (RED-213)
**Last edited:** 2026-04-16

---

## Purpose

`security exec: { allowed: true|false }` is a permission gate, not a sandbox. Once the gen flips it on, `execute_code` runs `python3 file.py` or `node file.js` directly via `execSync` — full filesystem read/write, full network, full env, unconstrained CPU/memory until the 30s timer fires, unconstrained subprocess spawn. The current state is a fig leaf: the gate creates the appearance of safety without delivering it.

This note settles the architectural decisions that turn `exec` into a real sandbox boundary, in the same shape that RED-220 settled engine mode: pick a substrate (or set of substrates), define the DSL surface, fix the inheritance and trace semantics, and identify the implementation tickets that fall out of those choices.

---

## The two substrates

This is the RED-220 framing pattern again, applied to exec. Cambium ships **two substrates that share one DSL surface and one adapter interface.** They differ in install story, isolation strength, and language ceiling — and the difference is exactly the line that makes engine mode work without expecting the host to operate Firecracker.

### WASM (the default)

In-process execution via [Wasmtime](https://wasmtime.dev) (the Bytecode Alliance Rust runtime) embedded in `@cambium/runner` as an npm dependency. The host needs **nothing** beyond `npm install`. JavaScript code runs inside **QuickJS-WASM** (~300KB, sub-ms cold-start, no Node APIs) — pinned as the v1 JS engine; the alternatives (V8-WASM at ~30MB) aren't realistic. Python is deferred to a v1.5 follow-up via Pyodide; v1 ships JS-only.

Capabilities are passed in explicitly via WASI: filesystem access only via preopens, no network, no subprocess spawn, no env. Resource caps (CPU/memory/wall-clock) enforced by Wasmtime itself. The escape surface is roughly "WASM runtime bug" — much smaller than "kernel CVE" or "container escape."

This is the default for new gens. It handles the realistic 95th-percentile use case for `execute_code`: math, JSON transforms, string manipulation, schema validation, simple algorithmic compute. No numpy, no `fs`, no `fetch`. By design.

### Firecracker (the upgrade)

Microvirt isolation via Firecracker microVMs on a Linux host with KVM. Engine-mode users do **not** get this for free — they have to operate a Firecracker daemon (or use a hosted Cambium runner that does). When available, it lifts every WASM constraint: real CPython with whatever libraries you bake into the rootfs image, real Node with `fs`/`fetch`/`child_process`, network namespaces, bind mounts, the lot.

Cold-start ~125ms, warm pool ~10ms. Linux-only. Requires KVM access (so: not in unprivileged containers; not on macOS without a Linux VM). When a gen declares `runtime: :firecracker` on a host where Firecracker isn't available, the runner errors at startup with a clear message.

### `:native` (back-compat fig-leaf, deprecated)

Today's behavior — `execSync` with no isolation. Continues to compile so existing in-tree gens don't break, but emits a `tool.exec.unsandboxed` trace event and a stderr deprecation warning on every run. Future strict-mode flag (`CAMBIUM_STRICT_EXEC=1`) hard-fails on it. New scaffolds default to `:wasm`.

### Why two, not one

Picking one substrate forces a bad choice. WASM-only means no Python with numpy, no Node APIs — fine for most users, hostile to scientific computing use cases that genuinely need them. Firecracker-only means engine mode breaks (no `npm install` story for KVM); only self-hosted Cambium services get exec at all.

Two substrates with one adapter interface is the cleanest line. Engine-mode users get sandboxing for free with their `npm install`. The deployed-service path opts into Firecracker when the use case demands it. The DSL says `runtime: :wasm` or `runtime: :firecracker` and the framework picks an adapter at startup. Most of the impl work is substrate-agnostic — only the adapter implementation differs.

The Rails analogy is **Solid Queue vs Sidekiq+Redis**: ship the lightweight default that handles 95% of real workloads in-the-box, support the explicit upgrade path for the cases that genuinely need it, design the abstraction for the swap from day one.

---

## What's mode-agnostic

Most of the framework doesn't change between substrates:

- The DSL `security exec:` block parses and emits `policies.security.exec`. The Ruby compiler and `parseSecurityPolicy` accept the new shape.
- The tool dispatch path (`handleToolCall`) routes `execute_code` through `ctx`, the budget gate, and the trace event pipeline. Substrate selection happens inside the `execute_code` handler.
- RED-137's network egress + per-tool budgets continue to gate non-exec tool calls. The exec sandbox's network policy can call into the same `NetworkPolicy` shape.
- Trace events follow the existing step-type vocabulary. New `Exec*` types slot in without runner-architecture changes.

What changes is **the substrate adapter** — the actual sandbox launcher — plus the DSL surface that selects between them and the trace types that describe the sandbox lifecycle.

---

## The adapter interface

Single `ExecSubstrate` interface, two implementations. The interface is small — getting it minimal and right once means new substrates (gVisor, Docker, others if anyone ever asks) drop in without framework changes.

```ts
interface ExecSubstrate {
  /** One-time check at runner startup: is the substrate usable on this
   *  host? Returns null when available, or a human-readable reason
   *  string when not (e.g. "Firecracker requires Linux+KVM; detected darwin").
   *  Called once and cached; never throws. */
  available(): string | null;

  /** Execute code in the sandbox. Returns a structured result; does NOT
   *  throw for in-sandbox failures (timeout, OOM, code error, egress
   *  denied) — those become structured `status` values on ExecResult.
   *  Throws ONLY for substrate-infrastructure failures (couldn't launch
   *  the sandbox at all). */
  execute(opts: ExecOpts): Promise<ExecResult>;
}

interface ExecOpts {
  language: 'js' | 'python';        // substrate must support; rejects unknown
  code: string;
  cpu: number;                      // cores (fractional ok); enforced per-substrate
  memory: number;                   // MB; enforced per-substrate
  timeout: number;                  // seconds wall-clock
  network: NetworkPolicy | 'none';  // NetworkPolicy shape from RED-137
  filesystem: { allowlist_paths: string[] } | 'none';
  maxOutputBytes: number;           // total stdout+stderr cap
}

interface ExecResult {
  status: 'completed' | 'timeout' | 'oom' | 'egress_denied' | 'crashed';
  exitCode?: number;                // present when status === 'completed'
  stdout: string;                   // may be truncated (see truncated.stdout)
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
  memPeakMb?: number;               // when substrate can report it
  reason?: string;                  // human-readable for non-completed statuses
}
```

The handler for `execute_code` selects the substrate based on `ir.policies.security.exec.runtime`, calls `available()` at runner startup (errors if unavailable for a declared runtime), and dispatches to `execute(opts)` per call.

---

## Architectural decisions

### 1. Substrate selection — settled

WASM (default) + Firecracker (opt-in) + `:native` (deprecated back-compat). See above.

### 2. DSL surface — settled

```ruby
security exec: {
  runtime: :wasm,                  # :wasm (default for new gens) | :firecracker | :native (deprecated)
  cpu: 0.5,                        # cores; range 0.1–4.0
  memory: 256,                     # MB; range 16–4096
  timeout: 30,                     # seconds; range 1–600
  network: :none,                  # :none | :inherit | { allowlist: [...] }
  filesystem: :none,               # :none | :inherit | { allowlist_paths: [...] }
  max_output_bytes: 50_000,
}
```

- **Required field:** `runtime`. Everything else has sensible defaults.
- **Inheritance semantics:** `network: :inherit` means "the sandbox sees the same allowlist the gen's `security network:` block declares." Author can narrow further (intersection) but never widen. Same shape for `filesystem: :inherit`.
- **Back-compat:** the existing `{ allowed: true }` form continues to compile. It resolves to `runtime: :native` and emits a deprecation warning. A future strict-mode flag (`CAMBIUM_STRICT_EXEC=1`) makes this a hard error.
- **Policy packs (RED-214):** `exec:` slots can be bundled in a pack. The per-slot mixing rule applies — `security :research_defaults` providing `exec` and the gen also providing `exec` is a compile error.

### 3. Resource limits live with `security exec:`, not `budget:`

The existing `budget` primitive caps tokens / tool calls / cost — accumulated per-run quantities checked at dispatch time. CPU/memory/wall-clock for a sandboxed subprocess are different: per-invocation, enforced by the substrate, declared next to `runtime:`. Mixing them into `budget` would conflate two genuinely different enforcement models. Keep them under `security exec:`.

### 4. Filesystem inheritance — settled

When `security exec.filesystem: :inherit`, the gen's `security filesystem: { allowlist_paths: [...] }` becomes the substrate's mount/preopen list. Read-only by default; explicit `{ allowlist_paths: [...], rw: [...] }` for read-write subsets.

Per-substrate translation:
- **WASM:** WASI preopens — capability handles to specific directories. No traversal possible (the WASI runtime resolves all paths against the preopen). Read-only by default; r/w preopens are a separate capability bit.
- **Firecracker:** rootfs image (the language interpreter + standard library) plus bind-mount overlays for the allowlist paths. Slow to rebuild per cold-start; pooling helps.

### 5. Network inheritance — settled with a v1 caveat

`network: :inherit` works the same shape as filesystem: the gen's `security network:` allowlist becomes the substrate's egress policy.

Per-substrate:
- **WASM v1:** **no network capability at all.** WASI sockets are barely a thing; we don't expose them. If a gen needs exec-with-network, that's a Firecracker use case OR the gen uses a separate tool (`web_search`, `web_extract`) that goes through `ctx.fetch`. This forces a clean architectural separation: "exec runs compute, tools run effects." Document this loudly.
- **Firecracker:** network namespace + iptables rules from the allowlist. The runner's existing SSRF guard (RED-137) doesn't run inside the sandbox; the sandbox enforces its own egress.

Future v1.5+ work could add a "proxy WASM exec network through ctx.fetch" path. Out of scope for v1 — the explicit `:none` semantics are simpler and cleaner.

### 6. Cold-start vs pool — per-call for v1

WASM cold-start is ~1ms; pooling adds complexity for marginal gain. Per-call.

Firecracker cold-start is ~125ms; agentic loops calling `execute_code` 10–50 times per gen run pay 1.25–6s of pure startup overhead. Pooling cuts this to ~10ms warm. **Per-call for v1, pooling as a separate impl ticket once we have real usage data.** Pooling has a state-leak hazard (sandbox reused with prior-call's filesystem state) that needs careful design — explicit reset between calls, or pool-per-config — and isn't worth getting wrong on the first ship.

### 7. Output capture + caps — settled

stdout/stderr piped from the substrate to the runner with the `maxOutputBytes` cap (default 50k, matches today's behavior). Each stream truncated independently with a clear marker (`\n[truncated at <N> chars]`); both `truncated` flags surface on `ExecResult`. Substrate-specific implementation (Wasmtime stdout pipe vs Firecracker vsock or stdio passthrough) but consistent shape.

### 8. Trace event vocabulary — settled

Six step types, substrate-agnostic:

- **`ExecSpawned`** — sandbox up, code dispatched. `meta: { runtime, language, cpu, memory, timeout }`.
- **`ExecCompleted`** — normal exit. `meta: { exit_code, duration_ms, mem_peak_mb, stdout_bytes, stderr_bytes, truncated }`.
- **`ExecTimeout`** — wall-clock cap hit. `meta: { duration_ms, timeout_seconds }`.
- **`ExecOOM`** — memory cap hit. `meta: { mem_peak_mb, memory_limit_mb }`.
- **`ExecEgressDenied`** — sandbox refused a network/fs operation. `meta: { kind: 'network'|'filesystem', target }`. WASM substrate v1 issues this whenever code tries any network operation (since WASM doesn't expose any); Firecracker issues it on iptables / mount-deny.
- **`ExecCrashed`** — sandbox-infrastructure failure (substrate bug, host issue). `meta: { reason }`. Distinct from `ExecCompleted` with `exit_code: != 0` (which is the code's own crash, not the substrate's).

Documented in `C - Trace (observability).md` once the impl tickets land.

### 9. Cross-platform stance — settled

Three rules:

- **WASM works on Linux, macOS, and Windows.** Wasmtime is cross-platform; this is the default precisely because it runs everywhere.
- **Firecracker works on Linux with KVM only.** When a gen declares `runtime: :firecracker` and `available()` returns a non-null reason, the runner fails at startup with that reason. No fallback. Forces the user to consciously choose between (a) running the workload on a Firecracker-capable host, (b) downgrading to WASM with the language constraints, or (c) running `:native` with the deprecation warning if they accept the dev-mode risk.
- **`:native` works everywhere.** Stays compile-valid for the deprecation period. Emits the warning on every run.

### 10. Migration of existing `security exec: { allowed: true }` gens — settled

Path (a) from the ticket: continue working with warning.

- The `{ allowed: true }` shape is rewritten at compile time to `{ allowed: true, runtime: :native }`.
- The runner emits a `tool.exec.unsandboxed` trace event on every `execute_code` call AND a stderr line: `WARNING: gen <name> uses exec runtime :native (no sandbox). Set runtime: :wasm or :firecracker to remove this warning.`
- A future strict-mode environment variable (`CAMBIUM_STRICT_EXEC=1`) makes this a hard compile error. Default is opt-in until at least one external user is running an exec-using gen in production.

### 11. Escape testing — settled (categories)

Test bench per substrate. Same coverage matrix; substrate-specific assertions.

| Category | What we assert | WASM expected | Firecracker expected |
| --- | --- | --- | --- |
| Env var egress | `os.environ.get('AWS_SECRET_ACCESS_KEY')` returns nothing | empty (no env exposed) | empty (no env passed through) |
| Cloud metadata | HTTP fetch of `169.254.169.254/latest/meta-data/` fails | egress denied (no network) | iptables drop |
| Filesystem (~/.ssh/) | `open('~/.ssh/id_rsa')` fails | no preopen for `~/` | no bind-mount for `~/` |
| `/etc/passwd` read | `open('/etc/passwd')` fails | no preopen | bind-mount denied |
| Subprocess spawn | `subprocess.run(['nc', ...])` fails | WASI doesn't expose process spawn | seccomp denies clone3 |
| Fork bomb | infinite spawn loop | WASI rejects | seccomp + cgroup pid limit |
| CPU burn | infinite loop | substrate CPU cap kicks in | cgroup CPU cap kicks in |
| OOM | progressive allocation | Wasmtime memory cap rejects | cgroup memory cap kicks in |

Lives at `packages/cambium-runner/src/builtin-tools/execute_code.escape-tests.ts` (or similar). Run as part of the regular suite; failure indicates a substrate config regression.

---

## Resolved decisions

The four calls that turned the open list into settled positions:

### A. Python in WASM — v1.5 (deferred)

V1 ships JS-only. Pyodide is its own follow-up ticket once the WASM substrate's adapter pattern is exercised in real use. Reasoning: Pyodide's ~10MB cold-load and the integration work (no native extensions, library-by-library compatibility quirks) would meaningfully expand v1 surface area. Python users in v1 get `:firecracker` as the answer; v1.5 brings Pyodide for the "I want a tiny Python compute" case.

### B. JS engine — QuickJS-WASM, pinned

The WASM substrate's JS execution surface IS QuickJS-WASM. Not V8-WASM (too big). Not a hand-rolled interpreter. The pin is in the design note rather than left as an impl-time choice because the alternatives aren't realistic and leaving it open invites bikeshedding.

### C. Firecracker rootfs image — ship a reference + document the recipe

Cambium ships a best-effort reference rootfs image with Python + Node. The image is **not** a production guarantee — users are expected to build their own for production deployments and own the CVE-tracking job. The reference image's value is "you can `cambium run` an exec gen on day one without writing a Dockerfile." Documentation includes the recipe to build your own.

### D. Pooling — deferred to a follow-up ticket; v1 design preserves the option

V1 ships per-call cold-start for both substrates (WASM ~1ms is free; Firecracker ~125ms is the noticeable cost). Pooling lands later when there's real usage data showing the cold-start is the bottleneck. The v1 adapter interface is designed so a pool can sit transparently in front of `execute()` without framework changes — when pooling ships, it'll be a substrate-internal optimization, not a DSL surface change. The pool design (per-config, explicit reset between calls) is the cleanest model; other options leak more state.

---

## The five impl pieces (and what's now pre-decided)

The decisions above settle most of the architecture. Each impl ticket below has a clear scope:

1. **Adapter interface + WASM substrate.** Foundational. Defines the `ExecSubstrate` interface, ships the Wasmtime + QuickJS-WASM implementation, plumbs the `execute_code` builtin to dispatch through it. Includes the substrate-agnostic trace-event emission and the WASM-specific resource-limit + filesystem-preopen + network-deny behavior. **Largest ticket.**

2. **DSL surface + Ruby parser.** Extends `security exec:` to accept the new shape. Preserves `{ allowed: true }` back-compat. Updates `parseSecurityPolicy` to emit the resolved `runtime`/`cpu`/`memory`/`timeout`/`network`/`filesystem` shape into `policies.security.exec`. Pack support follows from RED-214's per-slot mixing.

3. **Trace event types + observability.** Adds the six `Exec*` step types to the runner's emission path. Updates `C - Trace (observability).md` with the rows. Wires the `tool.exec.unsandboxed` warning trace + stderr line for the `:native` migration path.

4. **Escape-attempt fixtures + test bench.** The "looked secure, wasn't" test suite. Categories above; substrate-specific assertions; runs in the regular vitest suite.

5. **Firecracker substrate.** Same adapter interface, different implementation. KVM-required. Ships after WASM proves the pattern; gives the deployed-service path real Python/Node/numpy access. Requires the rootfs image strategy from open-decision (C) to be settled first.

Likely **6–7 actual tickets** after splitting where useful (e.g., Pyodide in WASM is its own ticket; pooling is another).

---

## Acceptance for this design note

- [x] Substrate selection (WASM + Firecracker + deprecated `:native`).
- [x] DSL surface for `security exec:`.
- [x] Adapter interface (`ExecSubstrate`) defined.
- [x] Inheritance semantics for filesystem and network.
- [x] Trace event vocabulary.
- [x] Cold-start vs pool stance for v1.
- [x] Cross-platform stance.
- [x] Migration path for existing `{ allowed: true }` gens.
- [x] Escape-test category matrix.
- [x] Calls made on the four formerly-open decisions (Python in WASM v1.5; QuickJS-WASM pinned; Firecracker reference image + recipe; pooling deferred).
- [ ] Each impl piece has a Linear ticket filed against it.
- [ ] First proof-of-concept: an `execute_code` invocation that successfully runs JS in WASM AND demonstrably fails the escape-fixture categories above.

---

## Out of scope

Re-stated from the parent ticket so the note doesn't drift:

- **Tool egress beyond exec.** RED-137 owns it for non-exec tools.
- **GPU access.** Not currently used by Cambium tools; later add via a `security exec.gpu:` extension.
- **Memory-pool / corrector / trigger sandboxing.** None of those run user-supplied code.
- **Sandboxing the Cambium runner itself.** Different threat model.
- **Tool exec on Windows.** WASM substrate works there; Firecracker doesn't. Document, don't engineer.
- **Pyodide Python in v1 WASM substrate** (per open-decision A — likely follow-up ticket).

---

## See also

- [[S - Tool Sandboxing (RED-137)]] — predecessor; this work extends `security` block with real exec semantics.
- [[P - Policy Packs (RED-214)]] — `exec:` slots need to be pack-bundleable.
- [[N - App Mode vs Engine Mode (RED-220)]] — engine-mode hosts need exec to work without monorepo assumptions.
- [[D - Tools Registry]] — `execute_code` is a framework-builtin tool, gets the substrate dispatch.
- [[C - Trace (observability)]] — the `Exec*` step types land here.
