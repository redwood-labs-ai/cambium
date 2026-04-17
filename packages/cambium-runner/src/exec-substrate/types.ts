/**
 * Tool exec sandboxing — adapter interface (RED-247 / RED-213).
 *
 * Two substrates share one DSL surface and one adapter interface:
 *  - `wasm` — in-process Wasmtime + QuickJS-WASM, ships with @cambium/runner
 *  - `firecracker` — microVM isolation, requires Linux + KVM, opt-in
 *  - `native` — back-compat fig-leaf; execSync; deprecated
 *
 * The handler for `execute_code` selects the substrate based on the gen's
 * `policies.security.exec.runtime` field, calls `available()` once at
 * startup, and dispatches to `execute(opts)` per call.
 *
 * See `docs/GenDSL Docs/S - Tool Exec Sandboxing (RED-213).md` for the
 * full design.
 */

import type { NetworkPolicy } from '../tools/permissions.js';

/** The substrate name as it appears in `security exec: { runtime: :X }`. */
export type SubstrateName = 'wasm' | 'firecracker' | 'native';

/**
 * One-adapter-per-substrate. Two methods: `available` (platform probe)
 * and `execute` (per-call dispatch). The interface is deliberately
 * minimal so adding new substrates later (gVisor, Docker, etc.) is a
 * drop-in change, not a framework refactor.
 */
export interface ExecSubstrate {
  /**
   * Is the substrate usable on this host? Called once at runner startup
   * when a gen declares this runtime; the result is cached. Returns null
   * when available; otherwise a human-readable reason string
   * ("requires Linux + KVM, detected darwin", "wasmtime not installed").
   * MUST NOT throw.
   */
  available(): string | null;

  /**
   * Execute code in the sandbox. Structured result — never throws for
   * in-sandbox outcomes (timeout, OOM, denied egress, non-zero exit).
   * Throws ONLY for substrate-infrastructure failures (couldn't launch
   * the sandbox at all), which surface as `ExecCrashed` in the trace.
   */
  execute(opts: ExecOpts): Promise<ExecResult>;
}

export interface ExecOpts {
  /** Languages the substrate must support. WASM v1 supports 'js' only;
   *  'python' in WASM is a v1.5 Pyodide follow-up. Firecracker supports
   *  both. Unknown languages MUST error with a substrate-specific message. */
  language: 'js' | 'python';

  /** The code string. The substrate is responsible for materializing
   *  it (temp file, in-memory blob, etc.). */
  code: string;

  /** Max cores (fractional ok). Translated to substrate-native limits
   *  — Wasmtime fuel, cgroup CPU shares, etc. Range 0.1–4.0 typical. */
  cpu: number;

  /** Max resident memory in MB. Range 16–4096 typical. Substrate
   *  enforces a hard cap; overflow surfaces as `status: 'oom'`. */
  memory: number;

  /** Wall-clock timeout in seconds. Substrate enforces; overflow
   *  surfaces as `status: 'timeout'`. */
  timeout: number;

  /** Network policy for the sandbox. `'none'` = no network at all.
   *  `NetworkPolicy` (from RED-137) = sandbox may reach hosts matching
   *  the allowlist, respecting block_private / block_metadata. */
  network: NetworkPolicy | 'none';

  /** Filesystem policy. `'none'` = no filesystem access. Otherwise the
   *  substrate exposes the listed paths (read-only by default). */
  filesystem: { allowlist_paths: string[] } | 'none';

  /** Total stdout + stderr cap in bytes. Default 50_000 at the DSL
   *  layer; passed through as an absolute cap. Overflow truncates
   *  with a marker; `truncated` flags surface on the result. */
  maxOutputBytes: number;
}

/**
 * Substrate-agnostic result shape. `status` is the primary discriminator;
 * other fields are populated where meaningful.
 */
export interface ExecResult {
  /** The outcome category. Trace events are emitted one-to-one with this:
   *  `completed` → ExecCompleted, `timeout` → ExecTimeout, etc. */
  status: 'completed' | 'timeout' | 'oom' | 'egress_denied' | 'crashed';

  /** Set only when `status === 'completed'`. 0 = success; nonzero =
   *  the guest code itself exited with an error (not a substrate issue). */
  exitCode?: number;

  /** Captured stdout. May be truncated — see `truncated.stdout`. */
  stdout: string;

  /** Captured stderr. May be truncated — see `truncated.stderr`. */
  stderr: string;

  /** Whether the corresponding stream hit `maxOutputBytes` and got
   *  truncated with a marker. */
  truncated: { stdout: boolean; stderr: boolean };

  /** Wall-clock duration in milliseconds. Always populated. */
  durationMs: number;

  /** Peak resident memory in MB, if the substrate can report it.
   *  WASM substrate: from Wasmtime. Firecracker: from cgroup stats.
   *  Native: unavailable. */
  memPeakMb?: number;

  /** Human-readable reason for non-`completed` statuses. Examples:
   *  "wall-clock timeout (30s)", "memory limit reached (256MB)",
   *  "network denied: 169.254.169.254". For `crashed` statuses, the
   *  substrate-infrastructure failure message. */
  reason?: string;
}

/**
 * Registry lookup type. The runner constructs this once at startup by
 * instantiating each substrate adapter and probing `available()`. The
 * `execute_code` handler picks the substrate named by the gen's
 * `security.exec.runtime` slot.
 */
export type SubstrateRegistry = Record<SubstrateName, ExecSubstrate>;
