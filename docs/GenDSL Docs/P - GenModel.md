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
  model "anthropic:claude-opus-4-7"
  effort "high"                                  # steering control on effort-models (RED-325)
  system :analyst
  returns AnalysisReport

  uses :web_search, :calculator
  corrects :math
  security :research_defaults                    # named pack (RED-214)
  budget   per_run: { max_calls: 20 }
  grounded_in :document, require_citations: true

  memory :conversation, strategy: :sliding_window, size: 20   # RED-215
  memory :facts,        scope: :support_team, top_k: 5
  writes_memory_via :SupportMemoryAgent

  def analyze(document)
    generate "analyze incident transcript" do
      returns AnalysisReport
    end
  end
end
```

A `GenModel` is a small declarations-only surface. It aggregates the primitives the framework knows about — model choice, contracts, tools, policies, memory, grounding, correctors, triggers — and the runtime applies them to every `generate` call within the class.

## `effort` (RED-325)

`effort` is the output-steering control for Anthropic models that dropped sampling
parameters — Opus 4.7+, Fable 5, Mythos 5. Those models reject `temperature`/`top_p`
(HTTP 400 if sent; Cambium omits them automatically), so `effort` replaces the sampling
knob on the newer generation.

```ruby
model "anthropic:claude-opus-4-7"
effort "high"
```

- **Values (closed):** `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Any other value
  is a compile error.
- **Anthropic-only:** `effort` is a compile error unless the primary `model` id carries
  the `anthropic:` prefix. It is an Anthropic Messages-API control with no analogue on the
  OpenAI-compatible (`omlx:`) or Ollama paths — the check gives a local pointer at compile
  time instead of a provider 400 at run time.
- **Wire behavior:** on an effort-model the runner sends `output_config: { effort: … }`
  alongside `thinking: { type: "adaptive" }`. `max_tokens` is sent unchanged — it is a
  required field on every Anthropic model, effort-model or not. See [[N - Model Identifiers]] and
  [[C - IR (Intermediate Representation)]] § Top-level IR fields for the exact request
  shape and IR field.
- **Mutually exclusive with `temperature`.** The two are never sent together. On an
  effort-model a co-declared `temperature` is silently dropped (it is inert on that model
  regardless of `effort`); on a sampling-model `effort` is never emitted. Declaring both
  is legal but only one takes effect per model generation.

## Failure modes
- Unknown model provider or model not available.
- Return schema not found (caught at compile time by RED-210).
- Memory-using gen without `better-sqlite3`/`sqlite-vec` installed → clear plan-time error.
- `effort` with a value outside `low`/`medium`/`high`/`max`, or on a non-`anthropic:` model → compile error (RED-325).

## See also
- [[P - generate]]
- [[P - returns]]
- [[P - uses (tools)]]
- [[P - mode]]
- [[P - Memory]]
- [[P - Policy Packs (RED-214)]]
- [[N - Model Identifiers]]
- [[D - Schemas (JSON Schema)]]
