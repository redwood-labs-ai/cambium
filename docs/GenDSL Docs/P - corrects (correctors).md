# Primitive: corrects (correctors)

**Doc ID:** gen-dsl/primitive/corrects

## Purpose
Attach post-generation validators/repairers (correctors) such as math/date/currency normalization.

## Semantics (normative)
- Correctors MAY be implemented as:
  - deterministic validators
  - deterministic transformers
  - or constrained repair prompts that update only invalid fields
- Corrector outcomes MUST be represented in the trace.

## Example
```ruby
corrects :math, :dates, :currency
```

## See also
- [[C - Repair Loop]]
- [[N - Failure Modes & Debugging]]
