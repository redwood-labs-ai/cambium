# syntax=docker/dockerfile:1.7
#
# Rootfs for Cambium's :firecracker exec substrate (RED-251 / RED-255).
#
# Two-stage multi-arch build:
#
#   Stage 1 (agent-builder) — Rust Alpine image, builds the
#   cambium-agent binary against musl. Output is a fully static
#   aarch64 (or x86_64 — whichever TARGETPLATFORM is) ELF.
#
#   Stage 2 (final) — the actual guest rootfs. Alpine 3.20 base plus
#   python3, nodejs, busybox, and the agent from Stage 1. PID 1 is
#   the agent itself: we symlink /init → /usr/local/bin/cambium-agent
#   so kernel boot drops into the agent directly.
#
# Build context is self-contained: build.sh stages a copy of the
# crates/cambium-agent source as ./agent-src before invoking `docker
# buildx build`. Keeps this Dockerfile portable without depending on a
# particular repo-root .dockerignore.

# ──────────────────────────────────────────────────────────────────────
# Stage 1: build the agent
# ──────────────────────────────────────────────────────────────────────
FROM rust:1.84-alpine AS agent-builder

# musl-dev gives us the C shims Rust's musl target links against for
# stdlib features. `pkgconfig` for dep-resolution sanity even though
# this crate has no native deps today.
RUN apk add --no-cache musl-dev

WORKDIR /build
COPY agent-src/ ./

# `cargo build --release` on rust:alpine produces a musl-static binary
# targeting whatever TARGETPLATFORM Docker hands us. No --target flag
# needed — rust:alpine's default toolchain IS the musl target.
RUN cargo build --release
RUN strip /build/target/release/cambium-agent

# ──────────────────────────────────────────────────────────────────────
# Stage 2: assemble the rootfs
# ──────────────────────────────────────────────────────────────────────
FROM alpine:3.20

# The runtime userland. Everything the guest code might legitimately
# reach for. `busybox` is redundant on Alpine (already present via the
# base) but listed for clarity; `ca-certificates` for any future
# network-enabled exec path.
RUN apk add --no-cache \
      python3 \
      nodejs \
      busybox \
      ca-certificates

# Agent binary from Stage 1. Installed at a conventional location + also
# at /init so the kernel can exec it directly via the `init=` cmdline
# parameter (or by fallback to /init on kernels that probe it).
COPY --from=agent-builder /build/target/release/cambium-agent /usr/local/bin/cambium-agent
RUN chmod +x /usr/local/bin/cambium-agent \
 && ln -s /usr/local/bin/cambium-agent /init

# Default CMD is the agent — useful for `docker run` smoke checks on a
# Linux+vsock host. Firecracker ignores this; it boots via kernel+init
# and doesn't use the OCI CMD. But it's a handy "does this image run at
# all" check.
CMD ["/usr/local/bin/cambium-agent"]
