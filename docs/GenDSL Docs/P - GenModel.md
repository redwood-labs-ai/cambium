# Primitive: GenModel

**Doc ID:** gen-dsl/primitive/genmodel

## Purpose
Declare a reusable, named generation unit with defaults: model, policies, tools, correctors, and return types.

## Semantics (normative)
- A `GenModel` defines defaults applied to all `generate` calls within the class unless overridden.
- A `GenModel` MAY define multiple methods that each contain `generate` transactions.

## Example
```ruby
class Analyst < GenModel
  model "ollama:llama3:70b"
  temperature 0.2
  returns AnalysisReport
end
```

## Failure modes
- Unknown model provider or model not available.
- Return schema not found.

## See also
- [[P - generate]]
- [[N - Model Identifiers (provider:model)]]
- [[D - Schemas (JSON Schema)]]
