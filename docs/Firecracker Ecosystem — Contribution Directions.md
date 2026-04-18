# Firecracker Ecosystem — Contribution Directions

> Captured 2026-04-18 after the RED-251 / RED-255 / RED-257 work landed. A brainstorm of directions to consider, not a plan of record. Nothing here is time-sensitive; this file exists so the ideas aren't lost the next time attention lands on the Firecracker layer.

## Why this document exists

Building Cambium's `:firecracker` substrate required standing up three assets from scratch that don't really exist — or exist only as fragments — in the open-source Firecracker ecosystem:

1. A reproducible ARM64 Linux+KVM host (the MS-R1) with Firecracker running end-to-end.
2. A reference host↔guest wire protocol (length-prefixed JSON over vsock) plus a working Rust guest agent.
3. A smoke / test harness that verifies a Firecracker host works from floor (KVM accessible) through integration (boot + round-trip).

Each of those is something other projects routinely reinvent. The ecosystem is thin on ARM64 tooling specifically, on "verify my Firecracker host works" utilities generally, and on a canonical reference for how an LLM-code-exec system should talk to a guest VM. This document captures the contribution-back opportunities that fall out of the work Cambium has already done.

## Context: who uses Firecracker

For framing the "where does Cambium fit" story to potential collaborators:

- **AWS Lambda / Fargate** — Firecracker was built for Lambda. Every Lambda invocation has run in a Firecracker microVM since late 2018.
- **Fly.io** — their entire platform is Firecracker. Every Fly Machine is one microVM.
- **Koyeb, Northflank** — serverless platforms in the same shape.
- **Modal Labs** — Firecracker for user code execution in their AI-workload platform.
- **Major LLM code-execution products** (OpenAI Code Interpreter, Anthropic's code execution, etc.) — don't publish architecture, but the infrastructure pattern has converged on microVMs as the answer.

The pattern (*run untrusted code in a microVM per call*) is well-established at hyperscale. What's underserved is the tooling *around* running Firecracker as a serious operator — especially on ARM64, especially for code-exec use cases. That's the gap the assets below address.

## Assets on hand

### 1. `crates/cambium-agent/` — Rust guest agent + wire protocol

- Statically-linked musl binary, stdlib-only (no tokio, no anyhow).
- Protocol: length-prefixed JSON over vsock, 4-byte big-endian u32 header, bounded frame size.
- Language-dispatching spawner (`run_exec` → JS / Python) with env-clear, UTF-8-boundary-aware output truncation, exit-classification (Completed/Timeout/Oom/Crashed).
- Validated end-to-end on the MS-R1 via `firecracker-testbed/smoke.sh`.

### 2. `firecracker-testbed/` — reference host verification harness

- Docker + compose stack deployable to any Linux+KVM host.
- Tiered smoke suite: v0 floor (KVM / binary / API) → v1 integration (boot + vsock round-trip).
- ARM64-native path for kernel fetch (Firecracker CI bucket) and rootfs build (multi-stage Dockerfile → `docker export` → `mke2fs -d` ext4 image, no loop mount).
- Python probe reference client for the wire protocol.

### 3. The MS-R1 (ARM64 Linux+KVM mini-PC)

- A reproducible ARM64 test target available on Steve's network.
- Firecracker v1.10.1 running cleanly end-to-end; all RED-257 escape-test categories green.
- Could in principle be CI for other ecosystem projects, though that's a bigger commitment (see below).

## Directions, organized by effort

### Low-hanging fruit — things that extract directly from work already done

#### Extract `firecracker-testbed` as a standalone repo

- "How do I verify that my host can actually run Firecracker?" is a question people ask and don't have a good answer to. The tiered smoke pattern (floor → integration, with SKIP on missing artifacts) is a generic pattern that isn't Cambium-specific.
- Repo name candidate: `firecracker-host-check`.
- Scope: the container, compose, smoke, probe, rootfs build, kernel fetch. Strip any Cambium-specific naming.
- Effort: a week of polish, README, CI.
- Positioning: "use this to validate a Firecracker host before you deploy anything serious to it."

#### Publish `cambium-agent` + wire protocol as a standalone crate + spec

- The agent crate is a complete, minimal reference for "talk to a host over vsock with length-prefixed JSON." Every AI-code-exec project on Firecracker writes this from scratch.
- Ship: the agent as a Cargo crate (rename to `firecracker-exec-agent` or similar), a short Markdown spec for the wire protocol, and the Python probe as a minimal host-side client.
- Effort: weekend of polish + rename + docs.
- Strategic value: first public thing from Redwood Labs, low-stakes way to put a real primitive out without committing to publishing all of Cambium. Makes Cambium itself look more credible as an adopter of reusable primitives rather than a monolithic framework.
- This is the meta-option most worth prioritizing — see "Recommended first move" below.

#### Blog post: "Firecracker on ARM64 end to end"

- Niche audience but highly concentrated. Anyone evaluating Firecracker on ARM (Graviton, Apple Silicon dev boxes, Pi 5s, Cambium-style custom hardware) lacks a "here's the whole flow" narrative. The existing docs assume x86_64 and pick up mid-pipeline.
- Scope: kernel fetch / build, rootfs build (multi-stage + `mke2fs -d` trick), Firecracker API sequence, vsock setup, common failure modes (we hit a few — the kernel-version 404, the `:ro` mount + `is_read_only: false` conflict, the PID-1 panic-on-exit gotcha).
- Effort: a weekend.
- Publishing: Redwood Labs blog / Hacker News / r/rust.

### Medium commitments — meaningful new work, valuable to the ecosystem

#### `firecracker-rootfs-kit`

- Every Firecracker user rolls their own rootfs build pipeline; each differs in annoying ways.
- Scope: a small project with templates (Alpine+Python, Alpine+Node, Debian+Rust, etc.), the `mke2fs -d` non-privileged pattern, sanity checks on the resulting image.
- Effort: 1–2 weeks.
- Our existing `firecracker-testbed/rootfs/` Dockerfile is 80% of an Alpine+Python+Node template already.

#### ARM64 Firecracker benchmarks

- Nobody has published good data on Firecracker cold-boot / snapshot-restore latency on ARM. We have a reproducible rig.
- Scope: p50/p95/p99 on cold boot, warm restore (post RED-256), memory overhead, max-VMs-per-core, etc., across a couple of ARM hosts (MS-R1 plus Graviton if available).
- Effort: 1–2 weeks of runs + 2–3 days of write-up.
- Strategic value: benchmarks are cited. Being the canonical source for "ARM Firecracker performance data" is a reputation asset.

#### ARM64 bug reports / fixes upstream

- ARM64 gets less testing in the Firecracker project than x86_64; we found an edge case in our own run (the kernel-version default 404'd against the CI bucket).
- Report issues as we hit them; contribute fixes where trivial.
- Ongoing, low friction.

### Bigger commitments — worth considering, not obviously worth doing

#### Snapshot/restore lifecycle wrapper

- Firecracker supports snapshot/restore but the ergonomics are rough. A wrapper that handles cache invalidation, resume error handling, and `enable_diff_snapshots` mechanics could generalize.
- Only worth extracting *after* RED-256 is built and production-tested — premature extraction usually produces the wrong abstraction.

#### Public ARM64 CI runner for Firecracker-ecosystem projects

- The MS-R1 could theoretically provide ARM64 CI for open-source Firecracker-adjacent projects (the main project's CI is AWS-hosted x86/ARM, but downstream projects often lack ARM).
- Real commitment: exposing a single dev host to the internet is a security question, a maintenance burden, and a reliability ask.
- Probably not worth it for one box. Worth reconsidering if the hardware ever multiplies.

#### Contribute to Kata Containers / Cloud Hypervisor

- Firecracker-cousins with less ARM64 testing. Lower-stakes contribution target because those projects aren't as AWS-opinionated.
- Indirect payoff for Cambium specifically; higher payoff for ecosystem reputation.

## Recommended first move

Of everything above, the highest-leverage thing to do is **extract `cambium-agent` + the wire protocol as a standalone crate + spec** ([candidate name: `firecracker-exec-agent`]). Reasons, in order:

1. **It makes Cambium itself look more credible** as an adopter of reusable primitives rather than a monolithic framework. "Cambium uses `firecracker-exec-agent` (which we authored separately)" reads very differently than "Cambium has its own vsock protocol."
2. **It's a low-stakes way to put *something* public under Redwood Labs** without committing to publishing all of Cambium yet. Ownership rehearsal without the full scope.
3. **The protocol fills a genuine ecosystem gap.** Every major player (Fly, Modal, probably the LLM-exec products) has reinvented this. A decent reference would shift the conversation and establish a convention.
4. **Small enough to document well in a weekend.** ~500 lines of Rust, ~200 lines of Python probe, a short Markdown spec, a README.

Second-priority item after that: **the ARM64 blog post** (same writing weekend, different output). High audience concentration, low effort, and it seeds awareness of the other extracted projects as a side effect.

The rest can sit here until there's reason to pick it up.

## Non-goals

- **Don't commit to ongoing maintenance we can't sustain.** Anything published needs a realistic answer to "who fixes this in 6 months?" For a one-dev operation, that's a constraint.
- **Don't compete with Firecracker itself.** All of this is *around* Firecracker, not alternative-to. The relationship is "we make it easier to adopt Firecracker," not "we offer a Firecracker replacement."
- **Don't position any of it as a product.** These are contribute-back primitives, not monetizable products. Mixing the two muddies Cambium's own story.

## Cross-references

- [`S - Firecracker Substrate (RED-251).md`](./GenDSL%20Docs/S%20-%20Firecracker%20Substrate%20%28RED-251%29.md) — design note for the substrate these assets emerged from
- `firecracker-testbed/` in the repo root — the testbed + rootfs build + kernel fetch
- `crates/cambium-agent/` in the repo root — the guest agent
- Linear: RED-251 (substrate), RED-255 (foundational agent+rootfs+testbed), RED-256 (snapshot/restore), RED-257 (escape tests), RED-258 (filesystem follow-up), RED-259 (network follow-up)
