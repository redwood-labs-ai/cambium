# Data: Packages & Workspaces (Scale-Invariant)

**Doc ID:** gen-dsl/data/packages-workspaces

## Purpose
Define a Cargo-workspace-like monorepo structure where packages are scale-invariant:
- a full app package
- or a single reusable tool/corrector/grounding source

All packages share the same contract: **shipped, documented, typed, and testable**.

---

## Opinionated stance: what a "package" is
A package is *not* a random folder.

A package is: **"stuff that works and we tried it."**

### Package requirements (normative)
A valid package MUST have:
1) `Genfile.toml` (manifest)
2) **Docs** (knowledge-graph pages with Doc IDs)
3) **Types/contracts** (TypeBox) that compile to JSON Schema
4) **Tests** (at least smoke tests)
5) Declared **exports** (what this package provides)

A package SHOULD have:
- example usage (`examples/`)
- a minimal runnable demo command
- changelog notes (optional v0)

---

## Workspace layout
Recommended monorepo layout:

```
Genfile.toml              # workspace root
packages/
  <pkg-name>/
    Genfile.toml
    src/
    app/                  # for app-style packages
    docs/
    tests/
```

### Workspace manifest (concept)
```toml
[workspace]
members = ["packages/*"]
```

---

## Package manifest: required fields (concept)

```toml
[package]
name = "tool-calculator"
version = "0.1.0"
kinds = ["tool"]

[docs]
root = "docs"

[types]
contracts = ["src/contracts.ts"]

[exports.tools]
calculator = "src/calculator.ts"

[tests]
smoke = "tests/smoke.test.ts"
```

---

## Enforcement
To keep packages honest, the toolchain SHOULD enforce requirements via:
- `gen lint` (manifest + structure validation)
- `gen test` (runs smoke tests)
- CI rule: no package can be depended on unless it passes lint+test

### Suggested rule
A package MAY be present in the workspace but MUST NOT be resolvable as a dependency unless it passes validation.

---

## Why this matters
- Prevents a "graveyard of half-baked tools"
- Makes reuse safe
- Makes the doc graph trustworthy
- Keeps the framework legible to humans and LLMs

---

## See also
- [[Generation Engineering DSL — Docs Map (Knowledge Graph)]]
- [[D - Tools Registry]]
- [[D - Schemas (JSON Schema)]]
- [[S - Tool Permissions & Sandboxing]]
