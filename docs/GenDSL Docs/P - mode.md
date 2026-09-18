# Primitive: mode

**Doc ID:** gen-dsl/primitive/mode

## Purpose
Control the execution strategy for `generate` blocks.

- **Default (no mode):** `generate` is a single LLM call. Tools fire post-generation via signals/triggers.
- **`mode :agentic`:** multi-turn tool-use loop — the model calls tools during generation, receives results, and iterates until it produces the final output.
- **`mode :retro`:** this gen is a *memory agent* (RED-215) that runs AFTER a primary gen, reads its trace via `reads_trace_of`, and returns `MemoryWrites` for the primary's memory slots. Not invoked directly by a user — the runner spawns it as a subprocess when a primary declares `writes_memory_via :ThisClass`.
- **`mode :decision`** (#275): routes eligible multiple-choice / yes-no tasks through a lightweight decision model (the built-in `typesafe` provider, Jev) instead of a frontier LLM. No prompt, no generated text — the `returns do … end` block IS the question set, and the answer is one of the declared options by construction.

## Semantics (normative)
- `mode :agentic` MUST enable multi-turn tool-use via the OpenAI function-calling protocol.
- Tool calls during generation MUST respect the `uses` allowlist (deny-by-default).
- Every tool call MUST be logged in the trace with typed I/O and timing.
- The loop MUST terminate when the model produces content without tool calls (final output).
- The loop MUST be capped by `constrain :budget, max_tool_calls: N` (default: 20).
- The loop MUST NOT re-execute an exact-duplicate tool call (same tool name + same
  arguments) that already returned this run (RED-184). The re-dispatch is skipped and
  the model is handed a `duplicate: true` result telling it the call already ran;
  the call still counts against `max_tool_calls`, so this is a faster trigger for
  the budget backstop, not a replacement for it. Only successful dispatches are
  remembered — a call that threw MUST still be retriable, since the throw describes
  that attempt and not the call. Exact match only — a duplicate `read_file` after a
  write to that file returns the pre-write result.
- The final output goes through the normal validate/repair pipeline.
- The user prompt MUST be split into a cacheable prefix (DOCUMENT + non-primary
  context sections) and the per-call instruction, whenever the prefix clears
  `MIN_CACHE_PREFIX_CHARS` (~4 KB) (#228). The agentic prefix deliberately does
  **not** carry the single-turn path's `OUTPUT_JSON_TEMPLATE` block: the
  pre-#228 agentic prompt never had one, and #228 is a cost fix that adds no
  prompt content (DEC-008). Unlike the single-turn path, the split is
  **size-gated only** — `grounded_in` is not required, because an agentic prefix
  is re-sent on every turn and the cache write pays for itself from turn 2 onward
  (a gen that answers on turn 1 pays the write without a read). Providers that
  cannot mark a prompt-cache breakpoint never see the split:
  the runner folds the prefix back into the first user message as
  `<prompt>\n\n<prefix>`, so oMLX/Ollama requests are unchanged.
- On Anthropic the loop MUST request the API's **automatic** cache breakpoint (a
  top-level `cache_control` field) rather than placing a rotating marker itself,
  and MUST keep explicit block-level markers at three or fewer — `system`,
  `tools[last]`, and the prefix. Anthropic's ceiling is four, the automatic
  breakpoint consumes one, and a fifth explicit marker is an HTTP 400 on every
  turn. See [[N - Model Identifiers]] § Anthropic prompt caching.
- A fan-out MUST NOT prewarm an agentic branch (#228). Prewarm fires through the
  single-turn path, which sends no tools; Anthropic builds cache prefixes
  `tools` → `system` → `messages`, so a tools-less warm-up diverges at the first
  level and writes an entry the branch can never read.

## Example

```ruby
class DataAnalyst < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :data_analyst
  mode :agentic

  returns AnalysisReport
  uses :calculator

  constrain :budget, max_tool_calls: 10

  def analyze(document)
    generate "analyze this document, use the calculator for computations" do
      with context: document
      returns AnalysisReport
    end
  end
end
```

## How it works
1. Model receives the task + tool definitions (OpenAI format)
2. Model responds with tool calls (e.g., `calculator({ operation: "avg", operands: [...] })`)
3. Runtime executes tool calls, returns results to the model. An exact repeat of an
   earlier call that succeeded (same tool + same args) is answered from memory instead
   of re-dispatched (RED-184) — the reply says so and the model is told to change tack
   or answer. A repeat of a call that failed is dispatched again.
4. Model iterates until it produces the final JSON output
5. Final output goes through validate → repair → correctors → signals/triggers

The shared head of the first user message (document + context sections — no
output template, per DEC-008) is assembled once, by the same helpers the
single-turn path uses, and re-sent verbatim on every turn — so on a
cache-capable provider it is written once and read on turns 2..N instead of
re-billed each time (#228).

## When to use which mode

| Mode | Use case | Tools | Cost |
|------|----------|-------|------|
| Default (no mode) | Data extraction, analysis | Post-generation via signals/triggers | 1 LLM call + signal-driven tools |
| `mode :agentic` | Multi-step tasks, coding, research | Model calls tools mid-generation | 2+ LLM calls, model decides when |
| `mode :retro` | Memory agent — decide what to remember after a primary gen | No tools (memory writes only) | 1 LLM call per primary run, best-effort |
| `mode :decision` | Forced-choice / yes-no classification (routing, triage, screening) | None — no tools, no generated text | 1 decision-model call, ~1 order of magnitude cheaper/faster than a frontier LLM |

## Retro-mode semantics (RED-215)

`mode :retro` flags a class as a memory agent. The framework, not the user, invokes it:

- The agent MUST declare `reads_trace_of :primary_class` (names the gen whose trace this agent reads).
- The agent MUST declare `returns MemoryWrites` (the structured write list the primary applies).
- The agent's entry method is always `remember(ctx)` — Cambium's `ActiveJob#perform`. The `ctx` argument is a JSON string with `primary_input`, `primary_output`, and `primary_trace`.
- A retro agent's own `memory :...` decls are skipped — memory machinery is suppressed when `ir.mode === 'retro'` to prevent recursion.
- Retro-agent failures never fail the primary run (best-effort writes). The primary's output is the contract.

Example:

```ruby
class SupportMemoryAgent < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :support_memory_agent
  returns MemoryWrites
  mode :retro
  reads_trace_of :support_agent

  def remember(ctx)
    generate <<~PROMPT do
      <RUN_DATA>
      #{ctx}
      </RUN_DATA>

      Based on the run data above, return a MemoryWrites object.
    PROMPT
      returns MemoryWrites
    end
  end
end
```

On the primary side: `writes_memory_via :SupportMemoryAgent`.

## `mode :decision` semantics (normative, #275)

`mode :decision` routes a gen through a Jev-shaped decision provider (built-in:
`typesafe`) instead of a text-generating model. There is no prompt to assemble
and no text to parse — the `returns do … end` block IS the question set, and
the answer fields are in-set by construction (the provider can only answer
from the declared set). The compiler-added `_decision` envelope is a
different story: it is the provider's own numbers, validated for shape and
finiteness but **not** for range (`confidence ∈ [0,1]`), completeness, or
sum-to-one — the vendor documents no structural invariants on it (see
Vendor limits and caveats below), so AJV is not "trivially satisfied" the
way the answer fields are.

```ruby
class TicketRouter < GenModel
  describe "Routes a support ticket to the team that should handle it and flags urgency."
  model "typesafe:jev-latest"          # fallbacks allowed: model "typesafe:jev-latest", "typesafe:jev-1.13.0"
  mode :decision
  system :ticket_router                # optional; rendered as state.system

  returns do
    # String + enum: → a choice. The Hash form carries per-option descriptions (Jev `criteria`).
    field :department, String,
      description: "Which team should handle this ticket?",
      enum: {
        billing:   "Payment, invoice, or subscription issues",
        technical: "Bugs, errors, or integration failures",
        sales:     "Pricing, plans, or account questions",
      }
    # Boolean → a yes/no (Jev `noul`). description: is the question.
    field :is_urgent, Boolean,
      description: "The ticket conveys urgency or time-sensitivity"
  end

  def route(document)
    generate "Route this support ticket" do   # the prompt string becomes state.task
      with context: document                  # every non-`_` context key lands under state.context
    end
  end
end
```

Output (`--mock`, deterministic — reproduces exactly (reformatted for
width) against
`cambium run app/gens/ticket_router.cmb.rb --method route --arg <fixture> --mock`,
per DEC-014: the first declared option, confidence `1`, every other
probability `0`; the boolean question's `probability: 0` → `false`):

```json
{
  "department": "billing",
  "is_urgent": false,
  "_decision": {
    "department": { "confidence": 1, "probabilities": { "billing": 1, "technical": 0, "sales": 0 } },
    "is_urgent":  { "probability": 0 }
  }
}
```

A real provider call reports the vendor's own numbers instead — e.g.
`{ "department": { "confidence": 0.596, "probabilities": { "billing": 0.84, "technical": 0.159, "sales": 0.001 } }, "is_urgent": { "probability": 0.999 } }`
— shaped the same way, but not reproducible (see Vendor limits and caveats:
no structural invariants).

- The question set MUST be derived from the `returns do … end` block, one field →
  one question, in declaration order: `String` + `enum:` → a **choice** question
  (the field's `description:` is the question's instructions; the enum keys are
  the options); `Boolean` → a **boolean** ("noul") question. `enum:` MAY be a
  Hash (`{ key => description }`) to carry per-option descriptions into the
  question (Jev `criteria`) — the Hash form is available in `mode :decision`
  only; everywhere else it is a `CompileError`. Every other `returns` type
  (Integer, Float, arrays, nested objects), `optional: true`, and a field with
  no `description:` are `CompileError`s naming the field — the description IS
  the question, and the model answers every declared question.
- `state` sent to the provider is a nested object, not a flattened prompt:
  `{ system?, task, context }`. `system` is present only when the gen declares
  one; `task` is the `generate "…"` prompt string; `context` is every non-`_`
  `ir.context` key, in declaration order, values passed through as-is. There is
  no `OUTPUT_JSON_TEMPLATE`, no SCHEMA block, no cacheable prefix — none of them
  apply to a typed-question request.
- Output MUST carry the answers at the top level plus a compiler-added
  `_decision` envelope: `{ <choiceField>: { confidence?, probabilities } }`
  for a choice — `confidence` present when the provider returns it, omitted
  (never defaulted or synthesized) when absent, since the vendor shows it in
  every documented example but does not guarantee it in writing (DEC-009b) —
  `{ <boolField>: { probability } }` for a boolean — the vendor's own single
  number, no synthesized complement (the vendor emits no boolean confidence
  either; none is synthesized). A Boolean answer is `probability >= 0.5`
  (`0.5` itself is `true`). Confidence (when present) and probabilities MUST
  also reach the trace's `Generate` step (`meta.mode: "decision"`,
  `meta.decision`) — this is the promised MUST, independent of whether the
  output shape is read downstream. `_decision` is part of the schema, so it
  is visible to pipeline `bind`, signal `extract`, and the serve `/v1/run`
  wire — a pipeline can read `bind(:step)._decision.<field>.confidence` as a
  value lookup, not inference (zero-inference-at-the-orchestration-layer
  holds: nothing in the pipeline layer *decides* anything from it), though a
  binding on `confidence` is only meaningful when the field is present. The
  envelope is closed (`required` + `additionalProperties: false`) at every
  level with two deviations: a choice entry's `probabilities` sub-object
  keeps the declared option keys as `properties` (documentation/typing) but
  drops BOTH `required` and `additionalProperties: false` — those keys are
  Cambium's, but the *map* is the vendor's, and a vendor-side additive change
  (a new bucket, or a truncated distribution above the vendor's documented
  option-count ceiling) must not be a terminal, un-repairable failure for the
  whole mode; and a choice entry's own `confidence` narrows only `required`
  (that entry stays `additionalProperties: false`) — `confidence` stays
  declared in `properties` but drops out of `required`, for the same
  DEC-009b reason. The runner passes `confidence` and `probabilities` through untouched (no
  filling missing keys, no synthesizing a default, no dropping unknown
  probability keys) and only finiteness-checks `confidence` (when present)
  and each **declared** option's `probabilities` value — an undeclared key
  inside `probabilities` is vendor metadata with no schema constraint of its
  own, so it passes through unchecked. `_decision` also participates in
  signal auto-discovery (`extract`'s no-`path:` substring match) like any
  other output key — a `extract` in decision mode SHOULD always name an
  explicit `path:` (e.g. `path: "_decision.department.confidence"`) rather
  than rely on auto-discovery, which can bind the whole envelope object
  where a scalar was expected.
- A response `decide()` actually returns MUST always produce a `Generate`
  trace row (#275 DEC-009b): once `decide()` has returned without throwing, a
  malformed envelope — a missing answer, `answers` not a map, a wrong `kind`,
  a non-string choice, or a non-finite number where one is required — pushes
  `Generate { ok: false, errors: [{ message }], meta: { model_used, mode:
  "decision" } }` with no output, and the run falls through the same
  Validate ("No data to validate") → terminal `Repair { reason:
  "decision_mode" }` tail an out-of-set choice already takes. Only a
  `decide()` call that itself THROWS — a transport/provider error, including
  "no decide()" — still propagates unhandled, the way a `generateText` throw
  does out of `handleGenerate`. A malformed `usage` object is the one
  exception to "loud failure": it is silently dropped (no budget accounting
  for that call) rather than failing an otherwise-fine run, the same posture
  `log` sinks take on sink failures.
- A decision-mode gen MUST NOT declare `returns :Symbol`, `corrects`,
  `constrain`, `grounded_in`, `enrich`, `temperature`, `max_tokens`, `effort`,
  `exclude_from_prefix`, `memory`, `writes_memory_via`, or `reads_trace_of` —
  each is a `CompileError` naming the declaration (no sampling on a decision
  model, no citations without generated text, nothing to correct on an answer
  drawn from an already-valid declared set; `memory` is refused because the
  runner appends the recall block to `ir.system` unconditionally of mode, so
  it would flatten into `state.system` on a vendor documented as not
  adversarially robust and subject to a distractor effect — opening it needs
  a design that routes recall into `state.context` instead, not shipped yet).
  `model` (+ fallbacks), `mode`, `describe`, `system`, `returns do … end`,
  `uses` + `extract` + `on`, `log`, `cron`, `security`, and `budget` remain
  available — `extract` + `on` is how a low-confidence answer gets *acted on*
  without any new semantics (expose, don't auto-act — see Confidence below).
- Validation failure MUST be terminal, not a repair opportunity: by
  construction the provider's answer is in-set, so an AJV failure here is a
  provider or normalization bug. The trace records `Repair { ok: false,
  meta: { reason: "decision_mode", deterministic: true } }` and the run ends
  `ok: false, failureKind: "validation"` — `handleRepair` (a text-model call)
  is never invoked. Handing "pick a value from this declared set" to a text
  model on failure would reopen the invented-value hazard closed for
  structural repair generally.
- `--mock` MUST be question-derived and deterministic, never a call to the
  text-mock generator: per choice question, the first declared option
  (`confidence: 1`, that option's probability `1`, every other `0`); per
  boolean question, `probability: 0` (→ `false`). This is byte-identical to
  what the schema-derived mock (`enum[0]`, `boolean → false`) would produce
  for the same fields, so a golden minted under `--mock` reads the way the
  schema mock would. Before the mock short-circuit, the SAME primary-provider
  capability gate that runs for a real call runs under `--mock` too: a
  decision gen wired to a provider with no `decide()` (a text provider, an
  alias/`--profile` swap gone wrong) fails under `--mock` with the same
  "does not support mode :decision (no decide())" error a real run would
  throw — `--mock` MUST NOT green-light a configuration that cannot run in
  production, mirroring the native-document gate that already applied this
  posture (#228/RED-323 DEC-B). The gate only fires for a *resolvable*
  provider; an unknown model prefix keeps its pre-existing mock behavior.

### Confidence: expose, don't act (v1 stance)

Cambium surfaces confidence and probabilities; it does not gate behavior on
them. There is no built-in "escalate to a frontier model below threshold" or
`branch_on` numeric-confidence routing — the vendor's own patterns route low
confidence to a human, never to a bigger model, and auto-fallback policy is a
product decision this framework does not make for you. `extract` + `on`
against `_decision.<field>.confidence` is today's mechanism for turning a low
score into a deterministic action (e.g. flag for review).

Cambium does not validate that `confidence` (or any probability) falls in
`[0, 1]` — only that, when present, it is a finite number. `confidence` on a
choice answer is itself optional (DEC-009b) — Cambium never checks that it's
*there*, only that it's finite when it is. A provider returning
`confidence: 42` or a `probabilities` map that doesn't sum to 1 passes
validation; range and sum-to-one are the vendor's numbers to keep honest, not
a contract Cambium enforces on your behalf.

### Vendor limits and caveats (Jev / `typesafe`)

- **State limit**: 32k tokens for `state` + the longest single question (64k
  total request budget). There is no pre-flight token count — an oversized
  request surfaces as a 422 with the vendor's own message.
- **Distractor effect**: accuracy falls as `state` grows with content
  unrelated to the decision. Keep the context focused on what the question
  actually needs.
- **Not adversarially robust**: the model has no defense against injected
  instructions inside `state` — do not decision-route untrusted text you
  wouldn't also trust a classifier to read unguarded.
- **No structural invariants**: a question and its negation need not sum to
  1, and independent questions in one request may disagree with each other —
  each question is evaluated independently, not jointly reasoned about. A
  choice question's `probabilities` IS documented to be the full probability
  distribution across every declared option, summing to 1, for up to 255
  options (`docs.typesafe.ai/primitives/choice`); behavior above 255 options
  is undocumented. `confidence` appears in every vendor example but is not a
  documented guarantee.

### When NOT to use `mode :decision`

- The task needs generated text (a summary, a rationale, free-form
  extraction) — Jev does not generate text; `generateText`/`generateWithTools`
  on the `typesafe` provider throw a deterministic pointer back to this mode.
- The choice set isn't known and fixed at compile time — decision mode's
  question set is derived from `returns`, not discovered at runtime.
- You need multi-hop reasoning across several dependent judgments in one
  call — questions are independent; a judgment that depends on a prior
  answer needs a second `generate` call (or a pipeline step).

## Trace output

```json
{
  "type": "AgenticTurn",
  "ms": 12074,
  "ok": true,
  "meta": {
    "turn": 1,
    "tool_calls": [{ "name": "calculator", "args": "{...}" }],
    "results": [{ "tool": "calculator", "output": { "value": 179.56 } }],
    "usage": { "prompt_tokens": 500, "completion_tokens": 361, "total_tokens": 861 }
  }
}
```

`mode :decision` reuses the `Generate` step type (no `Decide` step — one
provider call, one result, the same shape `Generate` already records) with
additive `meta` keys:

```json
{
  "type": "Generate",
  "ms": 340,
  "ok": true,
  "meta": {
    "model_used": "typesafe:jev-latest",
    "mode": "decision",
    "usage": { "prompt_tokens": 312, "completion_tokens": 48, "total_tokens": 360 },
    "decision": {
      "questions": 2,
      "answers": {
        "department": { "value": "billing", "confidence": 0.596, "probabilities": { "billing": 0.84, "technical": 0.159, "sales": 0.001 } },
        "is_urgent":  { "value": true, "probability": 0.999 }
      }
    }
  }
}
```

## Composability
- **With validate/repair**: final output is validated like any other generate; in
  `mode :decision`, repair is terminal on failure rather than a repair attempt
  (see above).
- **With correctors**: run after the agentic loop completes; not available in
  `mode :decision` (there is nothing to correct on a declared-set answer).
- **With compound review**: review checks the final output; not available in
  `mode :decision`.
- **With grounding**: citation enforcement on the final output; not available
  in `mode :decision` (no generated text to cite).
- **With signals/triggers**: fire on the final output (in addition to in-loop
  tool calls in `mode :agentic`) — this is fully available in `mode :decision`
  and is the mechanism for acting on a low-confidence answer.

## See also
- [[P - uses (tools)]]
- [[P - constrain]]
- [[P - Memory]]
- [[P - returns]] — the Hash `enum:` form and the compiler-added `_decision` schema property (`mode :decision` only)
- [[N - Agentic Transactions]]
- [[N - Model Identifiers]] — Anthropic prompt caching, agentic breakpoint allocation; the `typesafe` (Jev) provider row and the `decide` custom-provider extension point
- [[N - Orchestration Layer]] — fan-out cache prewarm (and why it skips agentic branches)
- [[C - Trace (observability)]]
- [[C - IR (Intermediate Representation)]] — `mode: "decision"` and the `decision` IR field
