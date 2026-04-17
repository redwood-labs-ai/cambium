# Firecracker testbed — v0 smoke container (RED-251).
#
# Goal for v0: give us a reproducible environment to verify
#   (1) Firecracker is installed and invocable
#   (2) /dev/kvm is accessible inside the container
#   (3) The Firecracker API socket accepts requests
# on an ARM64 host with KVM. This is a *testbed*, not the production
# :firecracker substrate — the real implementation ships alongside the
# impl tickets filed off `S - Firecracker Substrate (RED-251).md`.
#
# Built for aarch64 (the testbed host is an ARM mini-PC). If you
# rebuild on x86_64, swap the FIRECRACKER_ARCH below to x86_64.

FROM debian:bookworm-slim

ARG FIRECRACKER_VERSION=v1.10.1
ARG FIRECRACKER_ARCH=aarch64

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      jq \
      iproute2 \
 && rm -rf /var/lib/apt/lists/*

# Download the upstream Firecracker release for this architecture.
# The binary is statically linked; no runtime deps to chase.
RUN set -eux; \
    cd /tmp; \
    curl -fsSL -o firecracker.tgz \
      "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${FIRECRACKER_ARCH}.tgz"; \
    tar -xf firecracker.tgz; \
    mv "release-${FIRECRACKER_VERSION}-${FIRECRACKER_ARCH}/firecracker-${FIRECRACKER_VERSION}-${FIRECRACKER_ARCH}" /usr/local/bin/firecracker; \
    mv "release-${FIRECRACKER_VERSION}-${FIRECRACKER_ARCH}/jailer-${FIRECRACKER_VERSION}-${FIRECRACKER_ARCH}" /usr/local/bin/jailer; \
    chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer; \
    rm -rf firecracker.tgz "release-${FIRECRACKER_VERSION}-${FIRECRACKER_ARCH}"; \
    firecracker --version

WORKDIR /testbed
COPY smoke.sh /testbed/smoke.sh
RUN chmod +x /testbed/smoke.sh

CMD ["/testbed/smoke.sh"]
