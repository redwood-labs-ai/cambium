# ext4-builder — a tiny Linux container that turns `/out/rootfs.tar`
# into `/out/rootfs.ext4`. Exists because macOS hosts can't mkfs.ext4
# natively; this container provides the Linux tooling path regardless
# of build host.
#
# Uses `mke2fs -d <directory>` which populates the filesystem directly
# from a directory tree — no loop mount, no privileged Docker needed.
# The caller bind-mounts /out and we read/write there.

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      e2fsprogs \
 && rm -rf /var/lib/apt/lists/*

COPY build.sh /build.sh
RUN chmod +x /build.sh

ENTRYPOINT ["/build.sh"]
