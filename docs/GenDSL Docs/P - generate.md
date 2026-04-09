# Primitive: generate

**Doc ID:** gen-dsl/primitive/generate

## Purpose
Execute a governed generation transaction that returns a typed value (schema), with optional grounding + tool use, and built-in validate/repair.

## Semantics (normative)
A `generate` transaction MUST:
1) Construct a context bundle (explicit context + retrieved grounding, if enabled)
2) Call the model adapter
3) Validate output against the declared schema (if any)
4) Enforce configured policies (citations, tool allowlist, etc.)
5) If invalid, attempt repair up to `max_repair_attempts`
6) Emit a trace of every step

## Example
```ruby
def analyze(document)
  generate "analyze this document" do
    with context: document
    returns AnalysisReport
    require_citations!
  end
end
```

## Failure modes
- Validation fails after all repair attempts.
- Grounding policy requires citations but evidence cannot be found.

## See also
- [[P - returns]]
- [[C - Repair Loop]]
- [[C - Trace (observability)]]
- [[P - grounded_in]]
