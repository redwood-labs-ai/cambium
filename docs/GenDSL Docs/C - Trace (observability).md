# Runtime: Trace (observability)

**Doc ID:** gen-dsl/runtime/trace

## Purpose
Make every run debuggable and enterprise-auditable.

## Semantics (normative)
A trace MUST include:
- run id, timestamp, app version
- model id + parameters
- each IR step input/output (or hashes, per policy)
- tool calls with typed I/O
- validation errors
- repair attempts
- timing + token counts + cost estimates

## See also
- [[N - Failure Modes & Debugging]]
- [[C - Repair Loop]]
