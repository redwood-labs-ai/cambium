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
- [[P - Memory (design note)]] — design draft, no implementation yet (RED-215)

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
- [[S - Tool Permissions & Sandboxing]] — superseded by RED-137; retained for static-check design context
- [[S - Secrets & Data Boundaries]]

## Design notes
- [[N - Model Identifiers (provider:model)]]
- [[N - Failure Modes & Debugging]]
- [[N - VS Code Language Server]]
- [[N - Agentic Transactions]]
- [[N - GAIA Benchmark Evaluation]]

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
