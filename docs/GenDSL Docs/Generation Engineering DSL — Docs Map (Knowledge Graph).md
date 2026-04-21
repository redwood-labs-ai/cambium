# Cambium — Docs Map (Knowledge Graph)

This folder is the canonical doc graph for **Cambium** ("Rails for generation engineering").

## Start here
- [[00 - Getting Started]]
- [[01 - Core Concepts]]

## Primitives (language surface)
- [[P - GenModel]]
- [[P - generate]]
- [[P - returns]]
- [[P - grounded_in]]
- [[P - uses (tools)]]
- [[P - corrects (correctors)]]
- [[P - constrain]]
- [[P - Compound Generation]]
- [[P - enrich]]
- [[P - mode]]
- [[P - Policy Packs (RED-214)]] — named bundles for `security` + `budget`
- [[P - Memory]] — `memory` / `write_memory_via` / `reads_trace_of` / `mode :retro` (RED-215)

## Runtime + compilation
- [[C - IR (Intermediate Representation)]]
- [[C - Runner (TS runtime)]]
- [[C - Trace (observability)]]
- [[C - Repair Loop]]
- [[C - Signals, State, and Triggers]]
- [[C - Schema Description (auto-generated)]]

## Data + integrations
- [[D - Schemas (JSON Schema)]]
- [[D - Grounding Sources]]
- [[D - Tools Registry]]
- [[D - Packages & Workspaces (Scale-Invariant)]]

## Security model
- [[S - Tool Sandboxing (RED-137)]] — current spec: nested `security network:`, SSRF guard, IP pinning, per-tool budgets
- [[S - Tool Exec Sandboxing (RED-213)]] — design note: WASM-default + Firecracker-opt-in, two-substrate adapter, escape-test matrix
- [[S - Firecracker Substrate (RED-251)]] — design note: vsock control plane, snapshot/restore, Rust guest agent, minimal Alpine rootfs
- [[S - Tool Permissions & Sandboxing]] — superseded by RED-137; retained for static-check design context
- [[S - Secrets & Data Boundaries]]

## Design notes
- [[N - Model Identifiers]]
- [[N - Failure Modes & Debugging]]
- [[N - VS Code Language Server]]
- [[N - Agentic Transactions]]
- [[N - GAIA Benchmark Evaluation]]
- [[N - App Mode vs Engine Mode (RED-220)]] — engine-mode embedding design; runner-as-library, co-located gens, sentinel-aware authoring
- [[N - Corrector Multi-Attempt (RED-296)]] — re-run corrector after Repair, per-gen `max_attempts` knob, `CorrectAcceptedWithErrors` terminal trace state

---

## Doc conventions (LLM-first)

- Source DSL files use the double-extension convention: `*.cmb.rb`.
- Each page has a stable **Doc ID** and **Semantics** section.
- Prefer explicit, normative language: MUST / SHOULD / MAY.
- Every primitive documents:
  - **Purpose**
  - **Semantics** (what the runtime guarantees)
  - **Examples**
  - **Failure modes**
  - **See also** (explicit graph edges)
