# Primitive: grounded_in

**Doc ID:** gen-dsl/primitive/grounded-in

## Purpose
Enable retrieval grounding from a named source (corpus) and enforce provenance policies (citations/spans).

## Semantics (normative)
- When grounding is enabled, the runner MUST execute retrieval before generation.
- When `require_citations` is enabled, outputs MUST include citations for configured claim fields.

## Example
```ruby
grounded_in :company_docs
```

## Failure modes
- Source not configured or inaccessible.
- Required citations missing after repair.

## See also
- [[D - Grounding Sources]]
- [[C - IR (Intermediate Representation)]]
- [[N - Failure Modes & Debugging]]
