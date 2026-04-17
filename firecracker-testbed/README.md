# Firecracker testbed (RED-251)

A Komodo-deployable sandbox for iterating on the Firecracker substrate work. **Not the production substrate** — that ships alongside the impl tickets under [`S - Firecracker Substrate (RED-251)`](../docs/GenDSL%20Docs/S%20-%20Firecracker%20Substrate%20%28RED-251%29.md).

## v0 goal

Verify the floor: Firecracker installs, `/dev/kvm` is reachable from inside the container, the API socket responds. That's it. Real microVM boot + vsock round-trip land with the impl tickets.

## Deployment (Komodo)

Point Komodo at this directory. The compose build args + `/dev/kvm` passthrough should just work on an ARM64 host with KVM. Logs show a PASS/FAIL dashboard per check.

## Host prerequisites

- Linux with KVM (`/dev/kvm` exists and the container's uid/gid is in the `kvm` group).
- An ARM64 or x86_64 CPU (change `FIRECRACKER_ARCH` in `docker-compose.yml` if rebuilding on x86).
- Docker with `--device /dev/kvm` support (any modern Docker engine).

## Local run (non-Komodo)

```bash
cd firecracker-testbed
docker compose up --build
```

Expected final line on success: `All checks passed — testbed floor is solid.`

## What v0 proves

1. `/dev/kvm` is a char device with read+write access from inside the container.
2. The Firecracker binary is on PATH and reports its version.
3. Firecracker can open an API socket at `/tmp/fc-smoke.sock` and respond to `GET /machine-config`.

## What v0 does NOT prove

- Actually booting a microVM (needs a kernel + rootfs).
- vsock host↔guest communication (needs the Rust agent).
- Snapshot / restore lifecycle (needs the full substrate implementation).
- Any of the escape-test matrix.

Those come with the impl tickets.

## Iteration path

When the Rust agent + rootfs build pipeline land, this directory gets a second service (or the same service gains capabilities):
- A mounted volume for `vmlinux` + `rootfs.ext4` artifacts, either pulled from a release or built locally.
- An extended `smoke.sh` that actually boots a VM, establishes a vsock connection, and round-trips a trivial request.
- Eventually a parity run of the RED-250 escape-test categories against the Firecracker substrate.

## Troubleshooting

- **`/dev/kvm` missing inside container** → the `devices:` passthrough in `docker-compose.yml` isn't firing. Check Docker engine version and that Komodo honors the devices array.
- **`/dev/kvm` present but not writable** → the container's uid isn't in the host's `kvm` group. Either run the container as root, add `group_add: ["kvm"]` with the correct GID for your host, or change the host's `/dev/kvm` perms (not recommended).
- **Firecracker version mismatch** → bump `FIRECRACKER_VERSION` in `Dockerfile` to the current upstream release.
