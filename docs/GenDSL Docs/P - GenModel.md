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

## `exclude_from_prefix` (#182)

`exclude_from_prefix` names context keys that must reach the model but must **not**
contribute to the cacheable prompt prefix.

```ruby
class PageReviewer < GenModel
  grounded_in :raw_diff, require_citations: true
  exclude_from_prefix :page_id          # one key
  exclude_from_prefix :page_id, :run_seq # or several; calls accumulate
end
```

**The problem it solves.** Provider prompt caches address the prefix by a content hash,
so a single per-call byte splits it. A `fan_out` of 200 reviewers over one large grounded
document, where each branch carries its own `page_id` from a pipeline binding, gets 200
distinct prefixes: nothing is shared, the prewarm skips entirely (`meta.prewarm.skipped:
"no-shared-prefix"`, see [[N - Orchestration Layer]] § Fan-out cache prewarm), and every
branch races cold for the same document. Declaring `exclude_from_prefix :page_id`
collapses those 200 groups to **one**.

- **Declared on the gen, not on the key.** Prefix identity is a property of the gen, and
  the gen author is who tunes cache behavior — in the reproducing case `page_id` arrives
  from a *pipeline* `fan_out` binding, so a per-key marker would put the knob in the
  pipeline author's hands. Same shape as `grounded_in :document`, which likewise names a
  caller-supplied context key from a gen-level declaration.
- **It moves the key, it does not hide it.** Excluded keys render as their normal
  `<KEY>:` section (and `<KEY>_ANALYSIS:` for `_enriched` keys) into the *uncached tail*
  of the user prompt, appended after `generate`'s instruction. The provider orders
  `[prefix][userText]` and a cache region extends **backward** from its marker, so the
  tail is outside it automatically — no new provider mechanics. The model sees exactly
  the same sections it saw before; only their position changes.
- **Values (open):** any context key matching `/^[a-z][a-z0-9_]*$/` — the same shape
  every named-key surface in Cambium uses. Symbols or strings; repeated keys are
  de-duplicated; declaration order is preserved.
- **Not the `_` convention.** A `_`-prefixed context key (`_pipeline_arg` and friends) is
  framework-internal and is dropped from the prompt *entirely* — hidden **and** excluded.
  That meaning is unchanged; `exclude_from_prefix` is the additive knob for a key that
  must stay visible.
- **The key need not exist.** Naming a key that no caller ever supplies is silence, not
  an error: context is runtime and the declaration is compile-time, so a gen legitimately
  cannot know which optional keys arrive.
- **It only applies where it can help.** The exclusion takes effect **only when the
  cached-prefix path is actually active** — grounded (single-turn) and the prefix over
  ~4 KB. Below that, or on any provider that cannot mark a cache breakpoint (oMLX and
  Ollama always; Anthropic below the floor), the declaration is a **no-op**: the full
  prefix ships and the prompt is byte-identical to a gen that declared nothing. Without
  that rule the legacy prompt layout (`<instruction>\n\n<prefix>`) would put the excluded
  sections *before* `DOCUMENT:` for no caching benefit, and a gen with RED-421 fallbacks
  could present two different section orders in one run depending on which provider
  answered.
- **Watch out: excluding a large key can turn caching off.** The floor gate judges the
  prefix *after* the exclusion, so removing a big key can drop it under ~4 KB — the
  inverse of the intent. The `Generate` step's `meta.cache_prefix`
  (`{ judged_chars, used, excluded_chars }`) reports the decision on every run, and the runner
  writes one stderr line when a declaration is specifically the reason caching went off.
  Cambium does not override the author here; see [[C - Trace (observability)]]
  § `cache_prefix`.
- **Byte-identical when unused.** A gen with no declaration emits no `excludeFromPrefix`
  IR field and assembles the exact prompt it did before — on the single-turn path, the
  agentic path, and the semantic-repair path alike. See
  [[C - IR (Intermediate Representation)]] § Top-level IR fields.

## Failure modes
- Unknown model provider or model not available.
- Return schema not found (caught at compile time by RED-210).
- Memory-using gen without `better-sqlite3`/`sqlite-vec` installed → clear plan-time error.
- `effort` with a value outside `low`/`medium`/`high`/`max`, or on a non-`anthropic:` model → compile error (RED-325).
- `exclude_from_prefix` naming the `grounded_in` source → compile error (#182). The grounding document is the largest stable payload in the prefix and the entire reason the prefix exists; excluding it would silently destroy the caching the gen was tuned for.
- `exclude_from_prefix` naming a `_`-prefixed key → compile error (#182). Those keys never reach the prompt at all, so the declaration is a no-op that reads as if it did something.
- `exclude_from_prefix` with a key outside `/^[a-z][a-z0-9_]*$/` → compile error (#182).

## See also
- [[P - generate]]
- [[P - returns]]
- [[P - uses (tools)]]
- [[P - mode]]
- [[P - Memory]]
- [[P - Policy Packs (RED-214)]]
- [[N - Model Identifiers]]
- [[N - Orchestration Layer]]
- [[C - Trace (observability)]]
- [[D - Schemas (JSON Schema)]]
