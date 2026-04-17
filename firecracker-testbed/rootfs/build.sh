#!/usr/bin/env bash
# Build the :firecracker rootfs (RED-251 / RED-255).
#
# Produces `out/rootfs.ext4` — a bootable Alpine microVM rootfs with
# python3 + nodejs + the Cambium agent wired as PID 1.
#
# Runs on any host with Docker + buildx. On ARM64 Linux (the MS-R1
# testbed, or EC2 Graviton) the build is native. On macOS or x86 Linux,
# buildx uses QEMU to emulate the target arch — slower but correct.
#
# Env overrides:
#   PLATFORM         target platform tag  (default: linux/arm64)
#   ROOTFS_SIZE_MB   ext4 image size      (default: 256)
#
# Usage:
#   ./build.sh
#   PLATFORM=linux/amd64 ./build.sh    # for an x86_64 testbed

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
OUT_DIR="${HERE}/out"
mkdir -p "${OUT_DIR}"

PLATFORM="${PLATFORM:-linux/arm64}"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-256}"
ROOTFS_IMAGE="${ROOTFS_IMAGE:-cambium-rootfs:latest}"
EXT4_BUILDER_IMAGE="${EXT4_BUILDER_IMAGE:-cambium-ext4-builder:latest}"

# Short, bold stage headers so log skimming is easy.
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ──────────────────────────────────────────────────────────────────────
# Stage the agent source into the build context. Keeps the Dockerfile
# self-contained — it can reference `./agent-src` without depending on
# a repo-root build context + .dockerignore.
# ──────────────────────────────────────────────────────────────────────
step "1/4  Staging agent source"

AGENT_SRC="${HERE}/agent-src"
rm -rf "${AGENT_SRC}"
cp -R "${REPO_ROOT}/crates/cambium-agent" "${AGENT_SRC}"
# Strip any local build artifacts — they'd inflate the build context
# and are the wrong arch anyway.
rm -rf "${AGENT_SRC}/target"

cleanup() {
  rm -rf "${AGENT_SRC}"
  [[ -n "${CONTAINER:-}" ]] && docker rm "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ──────────────────────────────────────────────────────────────────────
# Build the rootfs OCI image. Multi-stage: stage 1 compiles the agent,
# stage 2 is the real guest image.
# ──────────────────────────────────────────────────────────────────────
step "2/4  Building rootfs image (${PLATFORM})"

docker buildx build \
  --platform "${PLATFORM}" \
  --tag "${ROOTFS_IMAGE}" \
  --load \
  "${HERE}"

# ──────────────────────────────────────────────────────────────────────
# Export the image's filesystem as a tar. `docker export` walks the
# final layer's rootfs; no OCI layer metadata, just files.
# ──────────────────────────────────────────────────────────────────────
step "3/4  Exporting filesystem tar"

CONTAINER=$(docker create --platform "${PLATFORM}" "${ROOTFS_IMAGE}" /bin/true)
docker export "${CONTAINER}" > "${OUT_DIR}/rootfs.tar"
docker rm "${CONTAINER}" >/dev/null
CONTAINER=""

echo "    $(du -h "${OUT_DIR}/rootfs.tar" | cut -f1) rootfs.tar"

# ──────────────────────────────────────────────────────────────────────
# Turn the tar into an ext4 filesystem image. macOS can't mkfs.ext4
# natively, so we use a Linux helper container (ext4-builder/) that
# has e2fsprogs. `mke2fs -d <dir>` bakes a directory tree directly
# into an ext4 image — no loop mount, no privileged access. Works on
# any Docker host.
# ──────────────────────────────────────────────────────────────────────
step "4/4  Building ext4 image (${ROOTFS_SIZE_MB}M)"

docker buildx build \
  --platform "${PLATFORM}" \
  --tag "${EXT4_BUILDER_IMAGE}" \
  --load \
  "${HERE}/ext4-builder" >/dev/null

docker run --rm \
  --platform "${PLATFORM}" \
  -v "${OUT_DIR}:/out" \
  -e ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB}" \
  "${EXT4_BUILDER_IMAGE}"

echo ""
printf '\033[32m✓\033[0m rootfs built:\n'
ls -lh "${OUT_DIR}/rootfs.ext4" | awk '{print "   " $0}'
echo ""
echo "Next:"
echo "  - fetch a kernel:  ../kernel/fetch.sh"
echo "  - once the testbed smoke v1 lands, booting this rootfs will be the real end-to-end verification"
