#!/usr/bin/env bash
# Fetch a Firecracker-compatible Linux kernel for this arch.
#
# Firecracker publishes reference kernel builds in S3 under their CI
# bucket. These are tested with the features we need (virtio-vsock,
# virtio-blk, devtmpfs auto-mount) and pre-compiled for both x86_64
# and aarch64. Reference builds only — production deployments should
# either track upstream + re-verify, or build from source for
# provenance control.
#
# Env overrides:
#   ARCH            aarch64 | x86_64           (default: aarch64)
#   KERNEL_VERSION  e.g. 5.10.225, 6.1.141     (default: 6.1.141)
#   FC_CI_TAG       Firecracker CI release tag (default: v1.11)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARCH="${ARCH:-aarch64}"
KERNEL_VERSION="${KERNEL_VERSION:-6.1.102}"
FC_CI_TAG="${FC_CI_TAG:-v1.11}"

OUT="${HERE}/vmlinux"
URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/${FC_CI_TAG}/${ARCH}/vmlinux-${KERNEL_VERSION}"

if [[ -f "${OUT}" ]]; then
  printf '\033[32m✓\033[0m %s already exists (%s)\n' "${OUT}" "$(du -h "${OUT}" | cut -f1)"
  echo "  rm ${OUT} to re-fetch"
  exit 0
fi

printf '\033[1m==> Fetching kernel vmlinux-%s (%s)\033[0m\n' "${KERNEL_VERSION}" "${ARCH}"
echo "    ${URL}"

# `-f` so curl exits non-zero on HTTP errors (otherwise we'd silently
# write an HTML 404 page as "vmlinux" and confuse Firecracker at boot).
curl -fL --progress-bar -o "${OUT}.tmp" "${URL}"
mv "${OUT}.tmp" "${OUT}"

printf '\n\033[32m✓\033[0m %s: %s\n' "${OUT}" "$(du -h "${OUT}" | cut -f1)"
echo ""
echo "Notes:"
echo "  - Reference kernel from Firecracker's CI bucket; NOT audited by the Cambium project."
echo "  - For production use, track upstream or build from source."
echo "  - Docs: https://github.com/firecracker-microvm/firecracker/tree/main/docs"
