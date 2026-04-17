# Firecracker rootfs build (RED-251 / RED-255)

Produces `out/rootfs.ext4` — the guest filesystem image Firecracker boots into.

## Contents

Alpine 3.20 base + `python3` + `nodejs` + `busybox` + `ca-certificates` + the Cambium guest agent wired as PID 1 (the kernel's `init=` cmdline points at `/usr/local/bin/cambium-agent`, which we also symlink to `/init` for kernels that probe that path).

Target size: ~150–180 MB (ext4 filesystem; the image file is sized at 256 MB by default to leave free-list headroom).

## Requirements

Either:

- **ARM64 Linux host** (the MS-R1 testbed, an EC2 Graviton, any Raspberry Pi): the build is native — fast, simple.
- **Any host with Docker + buildx**: `buildx` emulates the target arch via QEMU. Slower (a few minutes for the full build) but correct.

No Rust toolchain on the host is needed — the Dockerfile's stage 1 handles cross-compilation of the agent binary via Alpine's Rust image.

## Usage

```bash
cd firecracker-testbed/rootfs
./build.sh
```

Output lands in `out/rootfs.ext4`. Rebuild is idempotent — re-running produces a fresh image from the current source tree.

## Environment overrides

| Var | Default | Notes |
| --- | --- | --- |
| `PLATFORM` | `linux/arm64` | Set `linux/amd64` for an x86_64 testbed |
| `ROOTFS_SIZE_MB` | `256` | ext4 image size in MB |
| `ROOTFS_IMAGE` | `cambium-rootfs:latest` | local Docker image tag |

## Pipeline

```
crates/cambium-agent/   ─┐
                         │  stage 1 (rust:alpine)
                         ▼
                   cambium-agent (musl-static binary)
                         │  stage 2 (alpine + python3 + nodejs)
                         ▼
                   OCI image (cambium-rootfs:latest)
                         │  `docker export`
                         ▼
                   out/rootfs.tar
                         │  ext4-builder container (`mke2fs -d`)
                         ▼
                   out/rootfs.ext4  ←  what Firecracker mounts
```

The `ext4-builder/` subdirectory is a tiny Debian container with `e2fsprogs` installed — it exists because macOS hosts can't `mkfs.ext4` natively. It uses `mke2fs -d <dir>` which populates the filesystem directly from a directory tree (no loop mount, no `--privileged`).

## Rebuilding for different interpreter versions

Edit the `RUN apk add` line in `Dockerfile` to pin specific versions, e.g. `python3=3.12.11-r0 nodejs=20.15.1-r0`. Alpine's `pkgs.alpinelinux.org` has the current package index.

## Not for production

Reference image only. Production users should fork this Dockerfile and:

- Bake in whatever Python wheels / Node modules their gens need (so the guest code finds them without a runtime install step).
- Track CVEs on the Alpine base + bundled interpreters themselves.
- Consider pinning the Alpine digest (`alpine:3.20@sha256:...`) for reproducibility.

## Troubleshooting

- **`docker buildx build` fails with "no builder instance"** → `docker buildx create --use`, or `docker buildx install` on older Docker versions.
- **QEMU emulation is painfully slow on macOS** → expected; the MS-R1 or a Graviton EC2 builds natively in <1 minute.
- **`mke2fs` fails with "no space left on device"** → bump `ROOTFS_SIZE_MB`. The 256 MB default covers Alpine + python + node with headroom; if you're baking in heavy Python wheels the image size needs to grow.
