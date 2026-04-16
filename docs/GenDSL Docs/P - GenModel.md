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
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  temperature 0.2
  returns AnalysisReport

  uses :web_search, :calculator
  corrects :math
  security :research_defaults                    # named pack (RED-214)
  budget   per_run: { max_calls: 20 }
  grounded_in :document, require_citations: true

  memory :conversation, strategy: :sliding_window, size: 20   # RED-215
  memory :facts,        scope: :support_team, top_k: 5
  write_memory_via :SupportMemoryAgent

  def analyze(document)
    generate "analyze incident transcript" do
      returns AnalysisReport
    end
  end
end
```

A `GenModel` is a small declarations-only surface. It aggregates the primitives the framework knows about — model choice, contracts, tools, policies, memory, grounding, correctors, triggers — and the runtime applies them to every `generate` call within the class.

## Failure modes
- Unknown model provider or model not available.
- Return schema not found (caught at compile time by RED-210).
- Memory-using gen without `better-sqlite3`/`sqlite-vec` installed → clear plan-time error.

## See also
- [[P - generate]]
- [[P - returns]]
- [[P - uses (tools)]]
- [[P - mode]]
- [[P - Memory]]
- [[P - Policy Packs (RED-214)]]
- [[N - Model Identifiers]]
- [[D - Schemas (JSON Schema)]]
