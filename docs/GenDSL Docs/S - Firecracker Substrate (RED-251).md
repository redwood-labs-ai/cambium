## Note: Firecracker Substrate

**Doc ID:** gen-dsl/security/firecracker-substrate
**Status:** Draft (RED-251)
**Last edited:** 2026-04-17

---

## Purpose

The `:wasm` substrate (RED-254) handles the 95th-percentile `execute_code` case — JS compute, JSON transforms, schema validation, simple algorithmic work — with a memory cap, a wall-clock timeout, and implicit-deny on everything else. It doesn't handle Python with numpy, Node with `fs` / `fetch` / `child_process`, or any workload that genuinely needs host-kernel APIs. That's the `:firecracker` substrate's job.

This note settles the architecture for Firecracker: how the host talks to the guest, how VMs are lifecycle-managed, what runs inside the VM, and what the security surface looks like. The parent design note (`S - Tool Exec Sandboxing (RED-213).md`) pinned the substrate-selection tier (WASM default, Firecracker upgrade, `:native` deprecated back-compat) and the adapter interface (`ExecSubstrate`). This note is what actually fills the Firecracker adapter.

---

## Position in the architecture

One interface, three substrates. The `ExecSubstrate` contract from RED-247 is unchanged:

```ts
export interface ExecSubstrate {
  available(): string | null;
  execute(opts: ExecOpts): Promise<ExecResult>;
}
```

Firecracker is the substrate that gets installed when:
- The host is Linux with KVM (`/dev/kvm` accessible + the `firecracker` binary on PATH).
- The host operator has consciously provisioned it (a `cambium` deployment running in an unprivileged container can't host Firecracker; this is by design).
- The workload has outgrown WASM's limitations (real Python, native libs, `fs` access, subprocess spawn).

The DSL surface stays the same: `security exec: { runtime: :firecracker, cpu:, memory:, timeout:, network:, filesystem: }`. The substrate doesn't add new DSL fields; it lifts the capability ceiling on fields already accepted.

---

## Architecture

### Host / guest split

The Cambium Node runner lives on the host. For every `execute_code` call with `runtime: :firecracker`, the runner:

1. Ensures a ready-to-run VM snapshot exists (see "VM lifecycle" below).
2. Restores the snapshot into a fresh Firecracker microVM.
3. Opens a vsock connection to the running guest.
4. Sends an `ExecRequest` (language, code, stdin, caps) as JSON over vsock.
5. Waits for an `ExecResponse` (stdout, stderr, exit_code, duration).
6. Shuts the VM down. Disk state, memory, everything — gone.

The guest side is a minimal Linux system: a stripped-down Alpine rootfs, a Linux kernel, and a single static binary — the **Cambium guest agent** — running as PID 1. The agent listens on vsock, handles requests, and runs code with cgroup-ish constraints inside the VM.

### Control plane: vsock

Firecracker exposes three host-↔-guest channels: vsock (a native AF_VSOCK socket pair), a tap device with TCP, or the guest's serial console. **vsock is the right answer.**

- Zero network setup. No tap devices, no iptables, no IP routing per-VM.
- Firecracker-native: the VM config declares a vsock device and a port number; the host and guest both get sockets on that path.
- Well-trodden: the same approach Fly Machines and AWS Nitro Enclaves use for their control plane.
- Reserves tap for actual guest network egress, which is a separate concern the Firecracker substrate may or may not open up (see v1 network decision below).

The Node side talks to vsock via a small wrapper around `net.Socket` with `AF_VSOCK`. ~50 lines of host code; the Rust agent uses the standard library's vsock support.

### VM lifecycle: snapshot / restore

Cold-booting Firecracker + a Linux kernel + the Cambium agent end-to-end is ~500ms-1s. An agentic loop invoking `execute_code` 20 times per gen run would pay 10-20 seconds of pure substrate overhead. Unacceptable.

**Snapshot / restore is the Lambda pattern.** At substrate initialization, the runner:

1. Cold-boots one "template" VM.
2. Waits for the agent to reach its ready state ("listening on vsock port X, no request yet").
3. Firecracker `PauseVm` + `CreateSnapshot` captures the template's memory + disk + device state.
4. `StopVm` — the template is gone.

Every subsequent `execute()` call:

1. `LoadSnapshot` into a fresh Firecracker process. Typically ~50ms.
2. `ResumeVm` — agent is already listening (that's the state the snapshot captured).
3. Push the `ExecRequest` over vsock.
4. Wait for response.
5. `StopVm` — disposable.

Best of both worlds: every call gets a pristine VM state (no pool-state-leak hazard), but boot collapses from ~500ms to ~50ms.

Snapshot creation timing: on first-call (lazy), not at runner startup. Keeps the cold-path cheap for runs that never touch `execute_code`; first call to `:firecracker` pays the ~500ms snapshot-creation cost, every call after amortizes.

### Guest agent: Rust

The agent is the thing inside the VM that receives `ExecRequest` over vsock, writes code to a temp file, runs the interpreter, captures stdout / stderr / exit_code, returns `ExecResponse`. It's the critical security path — untrusted code handoff happens through it.

**Rust.** Memory-safe, no runtime, single static binary, ~200-300 lines for v1. The Rust standard library has vsock support since 1.78; no third-party crate needed for the transport. For invoking Python / Node, `std::process::Command` is sufficient.

The binary ships in the rootfs at `/usr/local/bin/cambium-agent` and runs as PID 1 (or via a minimal init that sets up cgroups then execs the agent). No shell, no sshd, no interactive users.

### Rootfs

Minimal Alpine-based rootfs, targeting ~100MB:

- Alpine base (~8MB).
- Python 3 + pip bindings (apk: `python3`).
- Node 20 (apk: `nodejs`).
- BusyBox for `sh`, `cat`, `env`, and the minimal coreutils the interpreters might shell out to.
- The Cambium agent binary (statically linked, ~3-5MB).
- A minimal Linux kernel built with the Firecracker-friendly config (virtio-vsock, virtio-blk, kvm guest).

No sshd, no package manager at runtime, no network tools (ping, curl, nc — absent from the image). Anything a gen needs, its code brings in bytes-as-code form; it does not reach for a host binary.

Build pipeline: Dockerfile → flatten to ext4 → ship alongside a matching Linux kernel image. Two artifacts per release: `rootfs-<arch>.img` + `vmlinux-<arch>`. Arch coverage v1: `x86_64` and `aarch64` (the Pi 5 testbed + standard EC2 / bare-metal x86). Hosted on whatever release surface the runner repo already uses.

For production: the recipe is published; teams bake their own image with whatever Python wheels or Node modules they need. The Cambium-shipped reference is for getting started and for the CI test bench — explicitly **not** a production-hardened image. Users own their own CVE tracking.

---

## Architectural decisions

Substrate decision pinned in the parent note (RED-213 §1). This note fills in the Firecracker-specific calls.

### 1. Control plane: vsock (not tap, not serial). PINNED.

See the Architecture section above. vsock is zero-config, firecracker-native, and decouples the control plane from any network setup.

### 2. VM lifecycle: snapshot / restore. PINNED.

See Architecture. Every call restores from the template snapshot, runs, disposes. Pooling deferred to a follow-up — snapshots give us pool-equivalent performance without the state-leak concerns.

### 3. Guest agent language: Rust. PINNED.

See Architecture. Memory-safe, small static binary, vsock transport in stdlib, audit-friendly.

### 4. Rootfs: Alpine + Python + Node + agent. PINNED.

See Architecture. Reference image hosted as a release artifact; production users bake their own.

### 5. Network: per-call netns + iptables allowlist (RED-259).

`network: :none` → no tap, no network device in the VM. Guest code that calls `fetch()` gets connection refused immediately.

`network: { allowlist: ['api.github.com', '1.1.1.1'], block_private: true, block_metadata: true }` → the host builds a per-call network namespace + veth pair + tap device + iptables filter chain before spawning Firecracker:

- **Netns topology**: two disjoint /24s. Host ↔ netns veth pair on `10.100.0.0/24`, netns ↔ guest tap on `10.200.0.0/24`. MASQUERADE on `POSTROUTING` rewrites guest-sourced packets as they exit the host's default interface; a return-path route on the root netns (`ip route add 10.200.0.0/24 via 10.100.0.2 dev <veth-h>`) makes reply packets un-NAT back to the guest. Same topology the RED-259 preflight (`firecracker-testbed/netns-preflight.sh`) proved GREEN on the MS-R1.
- **iptables policy in the netns**: FORWARD chain defaults to DROP. Stateful `ESTABLISHED,RELATED` ACCEPT first (so TCP replies to allowed outbound connections come back). Then `block_metadata` DROP at the top of the allow-list (so even an adversarial allowlist pointing at metadata can't slip through). Then `block_private` DROPs covering `0.0.0.0/8`, RFC 1918, loopback, link-local. Then one ACCEPT per resolved allowlist IP. Order matters — the DROPs deliberately precede any ACCEPT so defense-in-depth holds even under an adversarial allowlist.
- **DNS pre-resolution on the host**: `firecracker-dns.ts::resolveAllowlist` walks the policy's allowlist, treats literal IPs as-is, runs each hostname through `node:dns/promises.resolve4`, filters blocked IPs out of the results, and fails cleanly if any name resolves only to blocked addresses. The guest rootfs has no resolver — adding one would require a stub server inside the netns and a second allowlist for which resolvers the guest may contact, which compounds rather than simplifies the security story. Instead, the agent receives a pre-baked `/etc/hosts` map via `ExecRequest.net.hosts`.
- **Firecracker runs inside the netns** via `sudo -n ip netns exec <name> firecracker --api-sock …`, so its virtio-net device attaches to the tap from the right namespace.
- **Privilege model**: netns + iptables manipulation needs CAP_NET_ADMIN. Default is `sudo -n` (non-interactive — cache via `sudo -v` first); `CAMBIUM_FC_NETNS_NOSUDO=1` skips the sudo prefix for environments that grant CAP_NET_ADMIN via setcap; `CAMBIUM_FC_PREPARED_NETNS=<name>` is the operator-managed escape hatch — Cambium skips setup/teardown entirely and uses a pre-configured netns (must match the `NETNS_NAME` / tap / subnets / IPs `firecracker-netns.ts` pins).
- **Cleanup**: `executeCold`'s finally block drains FC (awaits the SIGKILL'd child's exit) before tearing down the tap + netns — tearing down the tap while FC still holds an fd leaks kernel state.

**v1 constraints documented in the impl:**

- **Cold-only.** Snapshot caching is skipped when network policy is in play. A net-enabled-vs-net-disabled cache-key axis is a v1.5 follow-up. Gens with network policy pay ~200 ms per-call cold-boot.
- **Sequential only.** Device names are fixed (`cambium-fc` / `cam-fc-h` / `cam-fc-g` / `cam-fc-tap`); two concurrent `:firecracker` runs with network policy race. Callers serialize or use `CAMBIUM_FC_PREPARED_NETNS` with externally-managed per-caller names.
- **IPv4 only.** Allowlist IPv6 literals are accepted shape-wise but don't produce rules. IPv6 iptables is a v1.5 extension.
- **Wildcard allowlists rejected.** `allowlist: ['*']` and glob patterns like `'*.example.com'` refuse at resolve time — `:firecracker` requires an enumerable allowlist. Gens that need unrestricted network should use `runtime: :native`.
- **Denylist refused, not silently ignored.** `NetworkPolicy.denylist` is carried through the policy shape but `resolveAllowlist` throws on any non-empty denylist. RED-137's invariant says denylist wins over allowlist, and v1 doesn't implement per-denylist DROP rules yet — silently dropping the denylist would let a `:firecracker` gen have broader access than its `:native` equivalent. v1.5 adds real enforcement.

An alternative we considered but didn't ship: **HTTP proxy through the runner**. The agent would make outbound HTTP calls via a runner-provided proxy URL, reusing the SSRF guard from RED-137 verbatim. Rejected for v1 because it breaks arbitrary protocols (would only cover HTTP/HTTPS) and couples the guest's network path to the runner process's event loop.

### 6. Filesystem in v1: virtio-blk ext4 allowlist, read-only only (RED-258).

`filesystem: :none` → rootfs + tmpfs `/tmp` only; `/tmp` is always read-write, always ephemeral (dies with the VM).

`filesystem: { allowlist_paths: ['/data/in'] }` → for each declared host directory, the substrate builds a read-only ext4 image via `mke2fs -d <host_dir>`, caches it alongside the snapshot, attaches it to the VM as a virtio-blk drive (`/dev/vdb`, `/dev/vdc`, ... up to `/dev/vdy` — rootfs occupies `/dev/vda`), and the in-guest agent mounts `-t ext4 -o ro <device> <guest_path>` before dispatching user code. v1 uses identity mapping (host_path === guest_path). Each allowlist entry becomes exactly one drive, bounded at 24 entries.

**Firecracker does not support virtio-fs.** The design originally assumed host bind-mounts; hardware / firecracker device-list reality forced virtio-blk. Consequences:
- **Content freshness = image-build time.** Editing files under an allowlisted host directory while the VM runs has no effect until the cache entry invalidates and the image rebuilds on the next cold path. The snapshot cache key includes `hashAllowlist(entries)` — an mtime/size/inode signature of each host directory — so content changes DO invalidate between runs automatically.
- **Read-only only in v1.** The wire protocol has a `read_only` bool, but the host hardcodes `true` and the in-guest agent (`crates/cambium-agent/src/mounts.rs`) refuses any mount with `read_only: false` as belt-and-suspenders. Future read-write support requires touching both enforcement points.
- **Path validation is strict.** `validateAllowlistPath` rejects non-absolute paths, `..` segments, symlinks (`lstatSync` check — defense against a symlinked `/opt/mydata -> /etc` that would otherwise sneak past the prefix check), and any path colliding with the rootfs's filesystem layout. The collision check is split by the role the prefix plays:
  - `DEEP_FORBIDDEN_GUEST_PREFIXES` (`/bin`, `/boot`, `/dev`, `/etc`, `/init`, `/lib`, `/lib64`, `/proc`, `/root`, `/run`, `/sbin`, `/sys`, `/tmp`, `/usr`) — the prefix itself AND any subpath under it is rejected. These trees are system-owned (binaries, kernel interfaces, config, agent scratch); any user-side mount would shadow real files or agent writes.
  - `EXACT_FORBIDDEN_GUEST_PREFIXES` (`/`, `/home`, `/mnt`, `/srv`, `/var`) — only the exact prefix is rejected. Subpaths like `/home/user/project/data` or `/var/app/input` are accepted so a gen can identity-map a real workstation path without first copying it into `/opt/...`. This is Cambium's opinionated Rails-style stance: take a side on user space vs system space rather than refusing the whole FHS top-level.
- **`mke2fs` is a runtime host dependency.** Alongside the `firecracker` binary. Preflight fails loudly if `mke2fs` is missing from PATH.

`filesystem: :inherit` — resolves against the gen's outer `security filesystem:` block at parse time (already wired in RED-248's TS-side resolver). The substrate sees the already-resolved shape.

Out of scope for v1, tracked as follow-ups: read-write mounts, wildcard paths, non-identity guest paths, symlink-safe allowlisting.

### 7. Platform: Linux + KVM only.

`available()` returns null when:
- `/dev/kvm` exists and is accessible by the runner process.
- A `firecracker` binary is on PATH.
- The kernel is recent enough to have the required KVM features (check via `/proc/cpuinfo` flag sniff).

Returns a clear reason string otherwise. No nested-virt-on-Docker-Desktop workarounds — macOS hosts get the exact same message as Windows hosts ("use `runtime: :wasm` or run Cambium in a Linux+KVM environment").

### 8. Resource limits enforcement.

- **Memory:** Firecracker VM `mem_size_mib` config. Overflow surfaces as the guest OOM-killing (kernel OOM inside the VM), which the agent detects via exit code 137 and reports as `ExecOOM`.
- **CPU:** Firecracker VM `vcpu_count` + optional cgroup CPU shares at the host layer. V1 uses `vcpu_count: 1` and enforces `opts.cpu` via wall-clock shaping (a 0.5 CPU cap becomes a 2x timeout penalty). Cleaner cgroup-based CPU fairness is a v1.5 refinement.
- **Wall-clock:** host-side `Promise.race` between the agent's response and a timeout timer. If the timer wins, the runner sends a `KILL` request over vsock (best-effort) and `StopVm` unconditionally; response surfaces as `ExecTimeout`.
- **Output:** stdout + stderr captured by the agent, truncated at `maxOutputBytes` with the existing `[truncated at <N> bytes]` marker; `truncated` flags pass through the vsock response.

### 9. Trace events.

Reuse RED-249's `Exec*` vocabulary verbatim. The substrate populates the existing meta fields. Snapshot-path interactions surface as two NEW step types fired between `ExecSpawned` and the outcome event (see [[C - Trace (observability)]] for the full shape):

- `ExecSnapshotLoaded` — warm-restore path carries `cache_key` + `restore_ms`; cold-boot-and-save carries `cache_key` + `create_ms`.
- `ExecSnapshotFallback` — cache bypass with `cache_key` + `reason` (`missing` | `non_canonical_sizing` | `load_failed` | `shared_mem_unsupported` | `build_locked`).

**What shipped vs. what was originally sketched:**

- The `snapshot_restore_ms` meta field lives on `ExecSnapshotLoaded.restore_ms`, NOT on `ExecSpawned` — moving it onto the snapshot-specific event keeps `ExecSpawned` runtime-agnostic.
- `vcpu_count` / `mem_size_mib` are NOT currently on `ExecSpawned` meta (the meta is `{ runtime, language, cpu, memory, timeout }`). The snapshot cache keys on canonical sizing (1 vCPU / 512 MiB), and the actual values at boot-source PUT time are reconstructable from `ExecSpawned.cpu` / `.memory`. Add them if a trace consumer needs the substrate-normalized values explicitly.
- `rootfs_version` is deferred — requires the rootfs image to carry a version manifest, which RED-255 didn't ship. The cache-key hash serves as a content-identity surrogate in the meantime.

### 10. Security surface.

What the user gets for free:
- KVM VM boundary: guest kernel can't touch the host kernel's memory. Full Linux process isolation inside the VM is irrelevant — the VM boundary is the gate.
- Clean state per call: snapshot restore guarantees no residue from prior calls.
- No network by default, no unintended filesystem access, no env-var inheritance into the VM (the agent explicitly clears its env before spawning interpreters).

What the user has to trust:
- Firecracker itself (AWS-maintained, Lambda-grade).
- The Linux kernel running inside the VM (user operates the image; they own the CVE tracking).
- The Cambium guest agent (we audit it).

Primary escape vectors and who owns mitigation:
- **Guest kernel exploit → host kernel:** Firecracker mitigates via KVM boundary. AWS's job. Users keep their rootfs image patched.
- **Firecracker bug:** AWS's job; we track upstream releases.
- **Cambium agent bug (e.g., a deserialization flaw in the vsock request handler):** our job. The agent is small and Rust-safe; audit is tractable.

Not directly our job (but note):
- Agent handling malformed `ExecRequest` must not panic or leak host secrets. Use serde's strict-typed deserialization; reject on unknown fields.
- Agent must not log sensitive data into stdout/stderr where the model sees it.

---

## Escape tests

Extends RED-250's test bench for the Firecracker substrate. Same eight categories (env var egress, cloud metadata, `~/.ssh/`, `/etc/passwd`, subprocess spawn, fork bomb, CPU burn, OOM). Substrate-specific expected-status:

| Category | WASM expected | Firecracker expected |
| --- | --- | --- |
| Env var egress | ReferenceError (no `process`) | Agent clears env before spawning interpreter; guest sees no host env vars |
| Cloud metadata | no `fetch` | No network → connection refused |
| `~/.ssh/` access | no `fs` | Not in allowlist → file not found |
| `/etc/passwd` | no `fs` | The guest's own `/etc/passwd` exists; it's the VM's, not the host's. Test asserts guest `/etc/passwd` does NOT contain host usernames. |
| Subprocess spawn | no `child_process` | Allowed inside VM; the subprocess can't escape the VM. Test asserts spawned processes cannot read host filesystem or make network calls. |
| Fork bomb | substrate interrupt | Agent's cgroup pid limit + VM-level memory cap; host is untouched. |
| CPU burn | wall-clock timeout | Wall-clock timeout at host layer |
| OOM | QuickJS memory cap | Guest kernel OOM-killer; agent exit 137 → `ExecOOM` |

The Firecracker variant is gated behind `RED213_TEST_FIRECRACKER=1` AND `FirecrackerSubstrate.available() === null`. Runs on the testbed (CI host with KVM, or local Pi 5 / EC2 bare-metal).

---

## Operating Firecracker (host requirements)

A host that runs the `:firecracker` substrate needs:

- Linux kernel with KVM support enabled.
- Access to `/dev/kvm` for the runner process (usually means the runner runs as root OR the user is in the `kvm` group).
- The `firecracker` binary on PATH. Static; download from the upstream GitHub releases.
- Enough memory for the pool of VMs expected at peak concurrency (`mem_size_mib` × peak_concurrent_calls). 256 MB × 10 concurrent = 2.5 GB headroom.
- The Cambium-shipped rootfs + kernel OR a user-built replacement.

Practical deployment shapes:
- EC2 with nested virtualization enabled (i3.metal, m5.metal, or m5 with nested-virt flags).
- Bare-metal Linux (matters for CI, edge, or self-hosted).
- NOT: Lambda (can't run nested Firecracker), Fargate (same), most unprivileged containers (no `/dev/kvm`).

V1 does **not** ship a "run Firecracker in Docker" flow. If the user's Docker host has `/dev/kvm` available, the flow works; we don't engineer around the cases where it doesn't.

### Environment variables

The substrate reads four env vars at `available()` time and per dispatch. All four are operator-level (not per-gen policy — a gen can't change them via the DSL):

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CAMBIUM_FC_KERNEL` | yes | — | Absolute path to the Firecracker-compatible `vmlinux` kernel image. Validated at `available()`; a missing / non-existent path marks the substrate unavailable with a clear reason. |
| `CAMBIUM_FC_ROOTFS` | yes | — | Absolute path to the guest `rootfs.ext4` image (the RED-255 reference build or a user replacement). Validated at `available()` AND re-checked at dispatch time so a mid-life removal surfaces cleanly. |
| `CAMBIUM_FC_SNAPSHOT_DIR` | no | `packages/cambium-runner/var/snapshots/` (relative to the runner's source tree) | Absolute path override for the snapshot cache root. MUST be absolute and normalized — the substrate rejects `..` segments and non-canonical paths at `available()` (see `resolveCacheRoot`). Useful for pointing the cache at a fast scratch mount (NVMe, tmpfs) or sharing a cache across multiple runner instances on the same host. |
| `CAMBIUM_FC_DISABLE_SNAPSHOTS` | no | unset | Set to `1` to force the cold-only code path — no cache lookup, no snapshot save, every call full-boots. Escape hatch for (a) hosts where the shared-mmap `File` backend isn't available, (b) debugging whether the snapshot path is the cause of a misbehavior, (c) operationally invalidating a cache entry you can't easily `rm -rf`. |

### Snapshot/restore — implemented behaviour (RED-256)

What actually shipped, as settled fact (§A's open questions are now closed):

- **Lazy-first-call creation.** First call in a fresh workspace for a given `(rootfs, kernel, canonical machine-config)` tuple pays cold-boot + snapshot-create (~2.0-2.5 s on the MS-R1). Every subsequent call for that tuple hits the cache and runs warm-restore + request (~100-500 ms on the MS-R1 for most categories; the RED-256 spike measured p95 3.4 ms `/vm Resumed` → first-dial CONNECT-OK in isolation).
- **Canonical sizing = 1 vCPU / 512 MiB.** `ExecOpts.cpu` / `ExecOpts.memory` that normalize to these values (after `Math.max(1, Math.round(...))`) route through snapshot/restore. Anything else cold-boots with `ExecSnapshotFallback.reason = non_canonical_sizing`. One canonical shape per cache entry — NOT a `(cpu, memory)` matrix. Users who need bigger VMs pay the cold-boot cost.
- **Cache key.** SHA-256 of the rootfs file bytes ‖ SHA-256 of the kernel file bytes ‖ SHA-256 of the canonical machine-config JSON, all fed into a final SHA-256, first 16 hex chars used as the cache subdirectory name. An in-process cache by `(path, inode, size, mtimeMs)` avoids re-hashing multi-MB files on every dispatch.
- **Cache directory layout.** Each entry is a subdirectory under `CAMBIUM_FC_SNAPSHOT_DIR` (or the default) named by its cache-key prefix. Contents:
  - `mem.img` (0600) — memory image; ~513 MB for a 512 MiB VM.
  - `snapshot.bin` (0600) — Firecracker VM state; ~7 KB.
  - `rootfs.ext4` (0600) — staged writable copy of the source rootfs; drive path baked into `snapshot.bin`.
  - `vsock.sock` (0600) — parent vsock UDS; path baked into `snapshot.bin`.
  - `.lock` — per-entry `O_CREAT | O_EXCL` exclusive-access file; present only while a call holds the lock.
  Directory mode is 0700. All content is writable only by the runner user.
- **Per-entry locking.** Both `executeColdAndSave` and `executeWarm` acquire an exclusive `O_CREAT | O_EXCL` lock on `<cacheDir>/<key>/.lock` before touching the entry's shared files (the rootfs is mounted writable inside the guest; concurrent warm restores would otherwise have their `/tmp/script.js` writes stomp on each other — a correctness + data-isolation hazard, not just a quality issue). The non-holder falls back to pure cold-only (`ExecSnapshotFallback.reason = build_locked`) rather than blocking, keeping per-call latency bounded. Different cache keys are unaffected — cross-key concurrency is unchanged.
- **Cold-boot-and-save is a two-phase flow.** Phase 1 cold-boots the template VM, verifies the agent, pauses, snapshots, then DESTROYS the template. Phase 2 spawns a fresh Firecracker and runs the user's request through the normal warm-restore path. Both cache-hit and cache-miss end up using the same `restoreFromSnapshot` code for the actual user-request execution — simpler lifecycle, same execution semantics.
- **Fallback is silent to the user, visible in the trace.** Snapshot-save failure, snapshot-load failure, or any transient substrate error degrades to cold-boot with a `ExecSnapshotFallback` step recording the reason. The user's `execute_code` call still returns a valid result; the gen author wouldn't notice. Operators can grep `trace.json` for `ExecSnapshotFallback` entries to spot persistent fallback modes.
- **Cache invalidation is content-addressed.** Updating `rootfs.ext4` or `vmlinux` produces a new cache key; the old entry becomes stale and is never read again (but occupies disk until manually removed). If you upgrade the Firecracker binary version — which may change the snapshot format — the OLD cache entries will load against the NEW binary and might silently misbehave. The operator-side migration is: `rm -rf $CAMBIUM_FC_SNAPSHOT_DIR/` (or the default `packages/cambium-runner/var/snapshots/`) after any Firecracker upgrade.

---

## Impl sequence

Listed in the order they unblock each other. Concrete tickets file after this note lands.

1. **Guest agent (Rust).** Single static binary: vsock listener, request parser, interpreter spawner, output capture, response writer. Unit-tested against a mock vsock. Builds for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`.
2. **Rootfs build pipeline.** Dockerfile → ext4 image. Matching kernel config. Build script produces `rootfs-<arch>.img` + `vmlinux-<arch>`. Published as release artifacts.
3. **Host-side `FirecrackerSubstrate`.** Replaces the current stub. Firecracker HTTP-over-Unix-socket client (~100 lines), vsock client wrapper, snapshot creation + restore lifecycle, `ExecResult` assembly.
4. **Snapshot / restore machinery.** Template-boot, snapshot-create, per-call restore, per-call shutdown. Amortizes snapshot creation to first call.
5. **Filesystem allowlist resolution (RED-258).** Takes the resolved `ExecPolicy.filesystem`, validates + canonicalizes the allowlist, builds one read-only ext4 image per entry via `mke2fs -d`, and turns the list into Firecracker virtio-blk drive config entries attached as `/dev/vdb`..`/dev/vdy`. Read-only only in v1; the agent refuses `read_only: false` mounts as belt-and-suspenders.
6. **Escape test extension.** Adds the Firecracker variant to the existing RED-250 bench. Gated behind the env flag.
7. **Operating-Firecracker docs.** The shape of `Operating Firecracker` above, formalized. Includes the "build your own rootfs" recipe with a published Dockerfile.

Likely 5–7 actual tickets after collapsing where tightly coupled (e.g., agent + rootfs can be one ticket if the agent fits cleanly inside the rootfs build).

---

## Open decisions (worth a pass before impl tickets file)

### A. Snapshot creation timing

- **Lazy (on first call):** first `:firecracker` call pays the ~500ms template-boot cost; subsequent calls amortize. No daemon startup overhead. **Recommended.**
- **Eager (at runner startup):** every runner process pays the cost at startup, even runs that never touch exec.

Lean: lazy. No downside we've named.

### B. Reference rootfs: ship prebuilt AND recipe, or recipe only?

Decided earlier: both (prebuilt as release artifact + documented recipe). Worth confirming the prebuilt is tracked somewhere the image signing story can grow into (SHA256 alongside the release note, eventually SLSA provenance if we're being fancy).

### C. vCPU count per VM

`vcpu_count: 1` for v1. Simpler config, lower memory overhead, predictable CPU accounting. Any reason to push higher? A gen that genuinely needs parallelism inside its compute would tell us; speculative `vcpu_count: 2` burns host resources for no current benefit.

### D. Agent ↔ runner protocol: JSON over vsock vs a smaller binary format?

JSON is the obvious choice — easy to debug, easy for the Rust agent to serialize via `serde_json`, easy for Node to generate. Throughput doesn't matter much (code payloads are small). V1: JSON. If profiling shows serialization is a bottleneck, revisit.

### E. Maximum code size per request

Code is transmitted over vsock in the `ExecRequest`. A 1 MB code blob is ~instant; a 100 MB code blob is not. V1 cap: `max_code_bytes: 10_000_000` (10 MB) — more than any realistic model-generated code. Agent rejects larger requests with a clear error. Configurable later if we find a driver.

---

## Out of scope

- **Pooling warm VMs.** Snapshots give us per-call pristine state + fast boot; pooling on top adds state-management complexity for a smaller win. Follow-up when perf data demands it.
- **GPU access.** Not in the DSL, not requested, not worth engineering speculatively.
- **Warm-restore + network policy.** Network-enabled gens always cold-boot in v1 (see §5); the snapshot cache doesn't key on network-presence. v1.5 adds the axis.
- **Concurrent network-enabled `:firecracker` calls.** v1 uses fixed device names; two concurrent runs race. Serialize at the caller or use `CAMBIUM_FC_PREPARED_NETNS` with externally-managed per-caller names. Per-call unique names are a v1.5 follow-up.
- **IPv6 iptables.** Allowlist v6 literals are accepted shape-wise but don't produce rules in v1. v1.5 extends.
- **Denylist enforcement in `:firecracker`.** Policy shape carries `denylist` through v1; `resolveAllowlist` refuses any non-empty denylist at dispatch time rather than silently ignoring. v1.5 adds per-denylist-entry DROP rules in the netns.
- **Windows hosts.** No path; `:wasm` covers it.
- **Sandboxing the Cambium runner itself.** Different threat model.
- **Multi-tenant Firecracker on shared hosts.** The design assumes the runner has exclusive use of the Firecracker daemon / rootfs images. Running multiple Cambium instances against shared Firecracker infra is a deployment concern, not a substrate concern.

---

## See also

- [[S - Tool Exec Sandboxing (RED-213)]] — parent design note; this one fills in the Firecracker half of the two-substrate architecture.
- [[S - Tool Sandboxing (RED-137)]] — the original tool-sandboxing work that introduced `ExecPolicy` + `NetworkPolicy`.
- [[C - Trace (observability)]] — the `Exec*` step types this substrate emits.
- [[P - Policy Packs (RED-214)]] — `exec:` slots are bundleable in packs; Firecracker-specific configs work in packs the same way.
