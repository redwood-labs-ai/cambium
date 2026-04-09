# Security: Secrets & Data Boundaries

**Doc ID:** gen-dsl/security/secrets

## Purpose
Define how models/tools access secrets and sensitive corpora.

## Recommended model
- Separate "runtime secrets" from "grounding corpora".
- Prefer scoped credentials per tool.
- Traces must support redaction and hashing policies.

## See also
- [[C - Trace (observability)]]
- [[D - Grounding Sources]]
