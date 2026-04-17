#!/usr/bin/env bash
# Runs inside the ext4-builder container. Reads /out/rootfs.tar and
# writes /out/rootfs.ext4. The outer build.sh bind-mounts /out.

set -euo pipefail

SIZE_MB="${ROOTFS_SIZE_MB:-256}"
IN_TAR="/out/rootfs.tar"
OUT_IMG="/out/rootfs.ext4"
STAGING="/tmp/rootfs-staging"

[[ -f "${IN_TAR}" ]] || { echo "ext4-builder: missing ${IN_TAR}"; exit 1; }

echo "    extracting rootfs tar..."
mkdir -p "${STAGING}"
tar -xf "${IN_TAR}" -C "${STAGING}"

# `mke2fs -d` takes a source directory and bakes its contents directly
# into a new ext4 image. No loop mount, no `mount --bind`, no
# --privileged. The image file grows to the size we request; extra
# space is free-list, not wasted.
echo "    creating ext4 image (${SIZE_MB}M)..."
rm -f "${OUT_IMG}"
mke2fs \
  -q \
  -t ext4 \
  -d "${STAGING}" \
  -L cambium-rootfs \
  "${OUT_IMG}" "${SIZE_MB}M"

echo "    done: $(du -h "${OUT_IMG}" | cut -f1) ${OUT_IMG}"
