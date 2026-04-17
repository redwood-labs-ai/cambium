# Firecracker kernel (RED-251 / RED-255)

The VM's Linux kernel — a separate artifact from the rootfs. Firecracker consumes them together: `rootfs.ext4` is the block device, `vmlinux` is the kernel image, and the boot cmdline (set via Firecracker's API) links them (`root=/dev/vda init=/usr/local/bin/cambium-agent` or similar).

## What's needed from a kernel here

Firecracker kernels are "just" Linux kernels compiled with a specific subset of features:

- **`virtio-vsock`** — host ↔ guest control-plane transport (how the agent talks to the runner).
- **`virtio-blk`** — guest access to the rootfs image as a block device.
- **`devtmpfs` + auto-mount** — so `/dev/*` populates itself at boot without a userspace init doing the work.
- **Minimal driver set** — everything else can (and should) be disabled. A stock Ubuntu kernel would work but is ~10× larger than necessary.

## `fetch.sh` — pull a reference build

```bash
./fetch.sh
```

Downloads a tested Firecracker-compatible `vmlinux` from Firecracker's CI S3 bucket. Reference only — not audited by Cambium; use for dev + testbed, re-verify or rebuild for production.

Env overrides:

| Var | Default | Notes |
| --- | --- | --- |
| `ARCH` | `aarch64` | Set `x86_64` for Intel/AMD hosts |
| `KERNEL_VERSION` | `6.1.102` | Available versions depend on `FC_CI_TAG` (v1.11 ships `5.10.225` and `6.1.102`) |
| `FC_CI_TAG` | `v1.11` | Firecracker's CI release tag; bump when they cut a new reference set |

## Why S3 + not a package manager

Firecracker kernels aren't in Debian / Fedora / Alpine repos because they're purpose-built for microVM use. The upstream project publishes their own tested builds alongside the Firecracker binary releases. We pin a specific version so the testbed is reproducible; re-running `fetch.sh` against the same env pulls the exact same file.

## Build from source (later)

For production, replace `fetch.sh` with a kernel build pipeline:

1. Clone `github.com/torvalds/linux` at the desired tag.
2. Apply Firecracker's minimal config (from the Firecracker repo's `resources/guest_configs/`).
3. `make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- vmlinux`.
4. Verify the resulting `vmlinux` against this doc's feature checklist.

Out of scope for RED-255 (v1). The reference build unblocks everything downstream; build-from-source is a follow-up when provenance requirements demand it.

## Troubleshooting

- **`curl: (22) The requested URL returned error: 404`** → the kernel version or CI tag has been rotated. Check https://github.com/firecracker-microvm/firecracker/releases for the latest reference kernel version + bucket path, update `KERNEL_VERSION` / `FC_CI_TAG` accordingly.
- **Kernel boots but no `/dev/vsock`** → `virtio-vsock` isn't compiled in. Reference kernels include it by default, but if you're using a custom build verify `CONFIG_VHOST_VSOCK=y` (or `=m` with module load at boot).
- **Kernel panics at init with "VFS: Unable to mount root fs on ..."** → the rootfs device name in the boot cmdline doesn't match what Firecracker attached. Firecracker's default drive name is `/dev/vda`; make sure the cmdline uses that (or whatever custom name you configured).
