# Firecracker testbed (RED-251 / RED-255)

A Komodo-deployable sandbox for iterating on the Firecracker substrate work. **Not the production substrate** — that ships alongside the impl tickets under [`S - Firecracker Substrate (RED-251)`](../docs/GenDSL%20Docs/S%20-%20Firecracker%20Substrate%20%28RED-251%29.md).

## Two levels of smoke check

- **v0 (floor)** — KVM accessible, Firecracker installed, API socket responds. Needs nothing beyond the container itself. Always runs.
- **v1 (integration)** — boots a real microVM with a real rootfs, establishes a vsock connection, round-trips one `ExecRequest` to the cambium-agent running inside, validates the response. Runs when kernel + rootfs artifacts are present; otherwise smoke.sh skips it with a clear hint.

## Deployment (Komodo)

Point Komodo at this directory. The compose build args + `/dev/kvm` passthrough should just work on an ARM64 host with KVM. Logs show a PASS/FAIL/SKIP dashboard per check.

## Host prerequisites

- Linux with KVM (`/dev/kvm` exists and the container's uid/gid is in the `kvm` group).
- An ARM64 or x86_64 CPU (change `FIRECRACKER_ARCH` in `docker-compose.yml` if rebuilding on x86).
- Docker with `--device /dev/kvm` support (any modern Docker engine).

## Local run — v0 only (no artifacts)

```bash
cd firecracker-testbed
docker compose up --build
```

Expected final line on success: `All checks passed — testbed floor is solid.` (v0), or `v0 checks passed. v1 integration skipped — see hint above.` if you haven't built the artifacts yet.

## Local run — v1 (full integration)

Build kernel + rootfs artifacts on the host first:

```bash
cd firecracker-testbed
./kernel/fetch.sh              # → ./kernel/vmlinux (reference build)
./rootfs/build.sh              # → ./rootfs/out/rootfs.ext4
docker compose up --build
```

The compose file mounts `./kernel` and `./rootfs/out` into `/artifacts/` inside the container (read-only). Smoke auto-detects them and extends into checks 4–5.

Expected final line on success: `All checks passed — Firecracker substrate floor + integration solid.`

## What v0 proves

1. `/dev/kvm` is a char device with read+write access from inside the container.
2. The Firecracker binary is on PATH and reports its version.
3. Firecracker can open an API socket and respond to `GET /machine-config`.

## What v1 additionally proves

4. A real microVM boots — kernel loads, rootfs mounts, cambium-agent launches as PID 1.
5. The guest agent accepts a vsock connection, reads a framed `ExecRequest`, dispatches to the Node interpreter, returns a framed `ExecResponse` that round-trips back through the parent UDS with the expected stdout, `exit_code = 0`, and `status = "completed"`.

That's every link in the host→guest control-plane chain — the same chain the production `FirecrackerSubstrate` (TS) will ride on when it lands.

## What remains out of scope

- Snapshot / restore lifecycle (warm-start machinery).
- The host-side TypeScript substrate that drives this protocol from the runner.
- A parity run of the RED-250 escape-test categories against the Firecracker substrate.

Those ship with later tickets.

## Troubleshooting

- **`/dev/kvm` missing inside container** → the `devices:` passthrough in `docker-compose.yml` isn't firing. Check Docker engine version and that Komodo honors the devices array.
- **`/dev/kvm` present but not writable** → the container is NOT running as root for some reason (the Debian base defaults to root; Komodo or a base-image override might flip it). Either revert to root, or add `group_add: ["<numeric-kvm-gid>"]` with your host's kvm group GID (`getent group kvm | cut -d: -f3`). A named `group_add: ["kvm"]` fails because Debian's base image has no `kvm` group entry.
- **Firecracker version mismatch** → bump `FIRECRACKER_VERSION` in `Dockerfile` to the current upstream release.
- **v1: check 4 fails on `PUT /boot-source` with "No such file"** → the artifact paths are wrong. Smoke expects `/artifacts/kernel/vmlinux` and `/artifacts/rootfs/rootfs.ext4`. Check the `volumes:` block in `docker-compose.yml` and that `./kernel/vmlinux` and `./rootfs/out/rootfs.ext4` exist on the host.
- **v1: check 5 probe times out waiting for vsock UDS** → the VM booted but the agent never came up, so the parent UDS never accepts. Inspect the kernel log tail that smoke prints on failure. Common causes: rootfs doesn't contain `/usr/local/bin/cambium-agent` (rebuild the rootfs), kernel cmdline `init=` is wrong, or the kernel lacks virtio-vsock (check `kernel/README.md` feature requirements).
- **v1: round-trip returns `status = "crashed"`** → the agent ran but failed before dispatching the interpreter. The response's `reason` field (printed in probe output) names the failure mode — usually a missing interpreter in the rootfs (`node` / `python3` not on PATH).
