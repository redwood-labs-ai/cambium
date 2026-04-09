# Data: Tools Registry

**Doc ID:** gen-dsl/data/tools-registry

## Purpose
Central registry of tools that can be called by the runner.

## Semantics
- Each tool MUST declare input/output schemas.
- Tool calls MUST be mediated by policy (allowlist, sandboxing).

## See also
- [[P - uses (tools)]]
- [[S - Tool Permissions & Sandboxing]]
