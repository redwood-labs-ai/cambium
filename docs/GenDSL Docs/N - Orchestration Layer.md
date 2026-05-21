# Note: Cambium Orchestration Layer (`Pipeline` primitive)

**Doc ID:** gen-dsl/note/orchestration-layer
**Tracking ticket:** RED-374
**Status:** DESIGN NOTE — load-bearing decisions locked through 2026-05-17 conversation. Not yet implemented.
**Last edited:** 2026-05-17

---

## Purpose

Cambium today executes one gen per `cambium run`. Multi-gen pipelines — Gen A → Gen B → Gen C, or N specialists fanned out in parallel from the same upstream context — require a host script (a `.mjs` driver) or a parent TypeScript app calling `runGen` repeatedly to stitch the gens together. The host owns budget. The host owns trace stitching. The host owns failure semantics. Every downstream Cambium app rebuilds the same plumbing.

This note proposes a **`Pipeline` primitive** that owns multi-gen composition the way `enrich` owns pre-generation sub-agents, `compound :review` owns post-generation sub-agents, `cron` owns scheduled fires, and `log` owns trace fan-out. The orchestration layer is *opinionated*, *declarative*, and **inference-free** — it does not itself call an LLM to decide which step runs next.

---

## The forcing case

Two concrete shapes that today require host-script glue:

**Sequential pipeline (with rollup budget):**

```
TriageGen → RemediateGen → SummaryGen
```

Each gen has its own contract and budget. The host stitches outputs together and watches total spend. Without a pipeline primitive, "stop the whole flow if combined token spend exceeds 50k" requires bespoke accounting code per app.

**Fan-out + downstream synthesis (the canonical example — CI Review):**

```
SurfaceMapper → [SecurityReviewer, ArchitecturalReviewer, PerformanceReviewer, SemanticReviewer] → Fixer
```

Four specialist reviewers run independently against the same recon output. A downstream Fixer agent reads all four reviewers' findings and produces a patch. The host script today owns concurrency, failure thresholds, partial-output collection, trace nesting, and (the part that motivates pipeline-level memory) **how the Fixer accesses the union of reviewers' findings**.

Both shapes generalize. Sequential: legal → financial → technical review. Multi-source enrichment running concurrently to collapse latency. Tournament-style A/B prompt strategies. Multi-aspect document review with a rubric per dimension. The shape is common enough that the runtime should own it once, well.

---

## The load-bearing invariant: zero inference at the orchestration layer

The pipeline DSL compiles to a deterministic IR DAG. The runner executes operators that are **pure code**. LLM calls happen only inside sub-gens.

No router model picks the next step. No "agent decides which branch to take." The DSL surface is closed — `step`, `fan_out`, `branch_on :signal` — and every operator's behavior is determined entirely by:

- The IR shape (compile-time)
- The signal values extracted from completed sub-gens (deterministic, schema-validated)
- Static configuration (concurrency, thresholds, budget cap)

This is what differentiates Cambium's orchestration layer from LangGraph / AutoGen / agent-router architectures. The pipeline is a typed DAG, not a chat. Every future operator proposal gets evaluated against this invariant: *if it requires an LLM call to decide the operator's behavior, it doesn't ship as a pipeline operator*. Signals and triggers remain the only dynamic-dispatch surface, and they're already deterministic post-gen.

This stance is opinionated. It's the same line `cron` draws (Cambium owns the declaration; the operator owns the lifecycle — no in-process scheduler daemon), the same line `log` draws (framework-owned event vocabulary, no user-extensible enum), and the same line tool sandboxing draws (deny-by-default permissions, no model-mediated capability negotiation). Authors who genuinely need model-decided routing build it inside a gen using `mode :agentic` and tool calls — not as a pipeline operator.

---

## Decisions locked

### Shape

- **Separate class.** A pipeline is `class FooPipeline < Cambium::Pipeline`, not a `mode :pipeline` on `Cambium::GenModel`. Different shape: no `generate`, output composes from sub-gen outputs, the declaration is structurally distinct enough that overloading `GenModel` would muddy both.
- **Fan-out absorbed.** The earlier `RFC - Agent Fan-Out (Multi-Agent Parallelism) [DRAFT]` is folded in as the `fan_out` operator. No separate "fan-out primitive."
- **1:1 — one class, one method, one chain.** Each `Pipeline` subclass has exactly one entry-point method; operator declarations are class-level. The rare "two chains" case splits into two pipeline classes. Matches the "one file per object" structural invariant and keeps the IR shape clean.
- **Method body is empty / declarative.** The method (`def review(pr); end`) exists only to name the entry point and type its parameter. Class-level operators do the work. The compiler sees the entire DAG without partially executing Ruby.
- **First-step input via `input :name, schema: X`.** The pipeline declares typed inputs at the class top. Any step references them via `bind(:input).field` — symmetric with `bind(:step_id).field`, no first-step-is-special rule.
- **File location**: `app/pipelines/<name>.pipeline.rb` (matches `app/gens/`, `app/tools/`, `app/policies/`).
- **CLI**: `cambium run app/pipelines/<name>.pipeline.rb --method <method> --arg <input>` mirrors gens. Genfile catalog (used by `cambium serve`) recognizes pipelines alongside gens.

### Operators (v1)

Three, and exactly three:

- **`step`** — sequential, one sub-gen
- **`fan_out`** — parallel, N sub-gens against same upstream context, collected as a typed array
- **`branch_on :signal`** — deterministic conditional on an extracted signal value; routes execution to a named block of steps

Loops, `map_over :collection`, model-decided branching, and dynamic-fan-out are out of scope until a forcing case appears.

**`branch_on` exhaustiveness is enforced at compile time.** Either every enum value of the signal is matched by an `on` clause, or an explicit `default do ... end` block is declared. Missing both is a compile error. Forces the author to acknowledge every reachable path — same "no surprises at runtime" stance as the rest of the pipeline DSL.

### State and bindings

- **Three-level cascade for binding defaults.** Default is **explicit binding** at each step (`with: { ctx: bind(:triage).summary }`). The cascade matches model aliases (`app/config/models.rb`) and memory policy (`app/config/memory_policy.rb`):
  - Workspace-level (optional): `app/config/pipeline_policy.rb` sets `bind_defaults :pass_through` shop-wide.
  - Pipeline-level (optional): `bind_defaults :explicit | :pass_through` at the class top overrides the workspace default.
  - Per-step explicit `with:` always wins.
  
  v1 ships two modes: `:explicit` (shipped default — every step's inputs named) and `:pass_through` (prior step's output flows into the next step's primary input slot). Reusable named "binding packs" under `app/binding_packs/<name>.rb` defer until two pipelines genuinely share a pattern (RED-214 stance).
- **Strict compile-time bind-checks.** The compiler walks every `bind(:input).field` and `bind(:step_id).output_field` expression, resolves the target schema (pipeline's `input` block or step's `returns`), and errors at compile time on any unknown field. Same belt-and-suspenders stance as `returns` schema validation. Catches typos before runtime; pipeline IR is self-validating.
- **No binding sugar in v1.** Verbose `bind(:step_id).field` only. No `@step.field` or `prior.step.field` magic accessors. Sugar can land later if real authors complain it's verbose; it can't be removed once shipped.
- **How bindings reach the LLM prompt.** Each key in a step's `with:` map lands in the sub-gen's `ir.context` under that key name. The runner renders every non-internal `ir.context` key into the prompt as a labeled section: the **primary doc key** (`document`, or the `grounded_in :source` name) becomes the `DOCUMENT:` block; **every other key** becomes a `<KEY>:` block (uppercased key name). Non-string values are JSON-pretty-printed automatically — a step that binds `with: { axes: bind(:roller) }` and receives an `AxesRolled` object gets a clean `AXES:\n{ ... }\n` section in the downstream prompt. Two reserved name conventions: keys ending in `_enriched` use a back-compat label `<KEY>_ANALYSIS:` (originally the `enrich` primitive's output convention; preserved so prompts tuned to that label keep working); keys starting with `_` are framework-internal and never rendered. **Pipeline authors should name `with:` keys after the role the data plays in the downstream prompt** (`axes`, `analysis`, `findings`) — that's the label the LLM sees.

### Output

- **Output falls out of step IRs.** In the common case:
  - **Default**: pipeline output = last step's output, typed by that step's `returns`. Zero new declaration.
  - **Composition (optional)**: `output { ... }` block pulls named fields from step results. Assembled type falls out of the referenced steps' TypeBox schemas.
  - **Escape hatch**: explicit `returns CustomShape` + explicit `output` block for genuinely transformed outputs. Rare, not the default.

### Budget and policy

- **Pipeline budget is a simple top-level cap.** Each sub-gen retains its own budget controls; the pipeline adds a single ceiling (`budget tokens:`, `budget tool_calls:`) monitoring total spend across all sub-gens. No implicit splitting, no per-child re-allocation.
- **Policy inheritance: yes, sub-gen overrides.** A pipeline declaring `security :research_defaults` flows that pack into every sub-gen by default; the sub-gen's own `security` block overrides per-slot (same RED-214 per-slot mixing rule).
- **Cancellation is cooperative.** When the pipeline budget cap trips mid-fan-out, in-flight branches let their current tool call complete (tool calls are transactions); the next sub-gen turn doesn't start. No mid-tool aborts; no risk of partial non-idempotent side effects.

### Pipeline memory (new — see "Pipeline memory" section below)

- **Pipelines can declare `memory` slots that act as intra-run scratchpads shared across sub-gens.** Forcing case: CI Review's Fixer wants to query the union of all four reviewers' findings.
- **Sub-gen opt-in is explicit.** Sub-gen declares `memory :findings, scope: :pipeline_run` to wire into the pipeline's bucket. A sub-gen's behavior never silently changes based on how it's invoked — same `memory :foo, scope: :pipeline_run` decl works the same standalone or pipelined.
- **Read-at-start / write-at-success lifecycle.** Falls out of the existing RED-215 invariant. Parallel branches don't observe each other's mid-execution state (they each read the bucket at branch start, before siblings have committed). Downstream gens see the union of all upstream writes when their own step starts.
- **Cross-run sharing is reachable via the existing scope vocabulary.** Default for pipeline-declared memory is `:pipeline_run` (intra-run). Authors who want cross-run state set `scope: :session` or `scope: :named_pool` on the pipeline-level decl. Same primitive, different scope value.

### Observability

- **Trace step types**: `PipelineRun` (top), `PipelineStep`, `PipelineFanOut`. No `PipelineBranch` wrapper — per-branch state lives in `PipelineFanOut.branches[]`.
- **`cron` at the pipeline level fires the whole pipeline.** Falls out naturally from the existing schedule design — `cambium schedule compile` recognizes pipelines alongside gens.
- **`log` at the pipeline level emits per-operator events.** Vocabulary extends the existing dot-notation: `<pipeline>.<method>.complete`, `<pipeline>.<method>.step.<step_id>.complete`, `<pipeline>.<method>.fan_out.<fan_out_id>.complete`. Same framework-owned enum stance.

### Designed-for, shipped-later

- **`cambium serve` streaming partial progress** — deferred to v1.5. v1 endpoints block on completion and return the assembled output.
- **`cambium replay <run-id>` for pipelines** — deferred, but v1 IR and trace are designed to be replay-adequate. Replay wiring is the next initiative after pipeline impl.

---

## DSL surface

### Canonical example: CI Review

```ruby
class CIReview < Cambium::Pipeline
  input :pr, schema: PullRequest

  budget tokens: 200_000
  budget tool_calls: 200
  security :research_defaults

  # Pipeline-level shared memory — Fixer can semantic-query findings
  memory :findings, strategy: :semantic, top_k: 10

  step :recon, gen: SurfaceMapper, method: :map,
    with: { ctx: bind(:input).pr }

  fan_out :reviewers, collect_into: :reviews do
    branch :security,      agent: SecurityReviewer,      method: :review
    branch :architectural, agent: ArchitecturalReviewer, method: :review
    branch :performance,   agent: PerformanceReviewer,   method: :review
    branch :semantic,      agent: SemanticReviewer,      method: :review

    concurrency 4
    on_branch_failure :continue
    require :all
    pass_context :surface_map
  end

  step :fix, gen: Fixer, method: :patch,
    with: {
      pr:      bind(:input).pr,
      reviews: bind(:reviewers)     # typed array of all four reviewer outputs
    }

  def review(pr); end                # empty body — entry point declaration only
end
```

Each reviewer gen (and the Fixer) declares `memory :findings, scope: :pipeline_run` to opt into the shared bucket. The Fixer reads it at its step start, seeing the union of all four reviewers' writes.

### Sequential pipeline

```ruby
class IncidentResponse < Cambium::Pipeline
  input :incident, schema: Incident

  bind_defaults :pass_through       # optional; default is :explicit
  budget tokens: 50_000

  step :triage,    gen: TriageGen,    method: :assess
  step :remediate, gen: RemediateGen, method: :plan
  step :summary,   gen: SummaryGen,   method: :write

  def respond(incident); end
end
```

With `bind_defaults :pass_through`, `triage`'s output flows into `remediate`'s primary input slot, and `remediate`'s into `summary`'s, without explicit `with:` clauses.

### Homogeneous fan-out sugar

When all branches share an agent class with different parameters:

```ruby
fan_out :reviews, collect_into: :review_results do
  agent DocumentReviewer, method: :review
  over [:legal, :financial, :technical], as: :aspect
  concurrency 3
end
```

Compiles to three branches calling `DocumentReviewer.review(aspect: <each>)`.

### Branching on a signal (exhaustive)

```ruby
step :triage, gen: TriageGen, method: :assess

branch_on bind(:triage).severity do
  on :critical do
    step :page_oncall, gen: PageOncall, method: :notify
    step :remediate,   gen: RemediateGen, method: :plan
  end
  on :high do
    step :remediate, gen: RemediateGen, method: :plan
  end
  default do
    # explicit no-op for :low and :info
  end
end
```

Every reachable path is either an `on` clause or the `default` block. The compiler validates that `severity` is an enum field on `TriageGen`'s `returns` schema and that the `on` values are valid members of that enum.

### Explicit output composition

```ruby
class AuditPipeline < Cambium::Pipeline
  input :document, schema: Document

  step :triage,    gen: TriageGen,    method: :assess
  step :remediate, gen: RemediateGen, method: :plan

  output do
    severity bind(:triage).severity
    actions  bind(:remediate).actions
    summary  bind(:remediate).summary
  end

  def audit(document); end
end
```

The output's TypeBox shape is assembled from the referenced steps' schemas — no `returns SomeShape` line needed.

---

## Pipeline memory

The value of `memory` at the pipeline level isn't cross-run state (sub-gens already cover that with their own memory decls). It's **intra-run shared scratchpad across sub-gens within a single pipeline execution**.

### Two mechanisms for downstream synthesis

Given the CI Review forcing case (four parallel reviewers → Fixer), two mechanisms are available:

**Mechanism 1: Typed fan-out result via `collect_into:`.** The Fixer reads `bind(:reviewers)` and gets a typed array `[SecReview, ArchReview, PerfReview, SemReview]`. Structured iteration. Compile-checked. **This is the default mechanism — no memory primitive needed.**

**Mechanism 2: Shared findings bucket via pipeline-declared `memory`.** Add this when the Fixer is *agentic* and wants to **query** findings during its tool loop (e.g., "find all auth-related concerns across reviews") rather than iterate the typed array. Reviewers write findings to the shared bucket at branch success; the Fixer reads it at its step start.

Both can coexist. For most pipelines, Mechanism 1 is the only one needed.

### Lifecycle (falls out of RED-215)

Pipeline-shared memory follows the existing read-at-start / write-at-success rule:

- A sub-gen's memory **read** happens during system-prompt assembly (start of `generate`)
- A sub-gen's memory **write** happens after successful gen completion (post-validate, per the existing invariant)
- For parallel branches in a fan-out: each branch reads the bucket at branch start (≈ t=0 for all branches), each writes at its own success time. Branches therefore **do not observe each other mid-execution** — branch isolation falls out of the lifecycle, not from a new coordination rule.
- For downstream steps: their step start fires after the upstream fan-out completes, so their read sees the union of all branch writes.

### Resolution: pipeline-authoritative, sub-gen opts in by name

Same pattern as named pools (RED-215):

- **Pipeline declares** the slot with its authoritative strategy/embed/keyed_by/retain:
  ```ruby
  class CIReview < Cambium::Pipeline
    memory :findings, strategy: :semantic, top_k: 10
  end
  ```
- **Sub-gen opts in** by declaring a memory slot with matching name and `scope: :pipeline_run`:
  ```ruby
  class Fixer < Cambium::GenModel
    memory :findings, scope: :pipeline_run    # wires to CIReview.findings
  end
  ```
- The sub-gen can override **reader knobs** only (`size`, `top_k`). Strategy/embed/keyed_by/retain are pipeline-authoritative — attempting to set them on the sub-gen is a compile error, matching the pool-vs-decl stance.
- The new scope keyword is `:pipeline_run`. Sits alongside `:session`, `:global`, `:schedule`, `:named_pool` as one of the closed set of scope vocabulary.

### Cross-run sharing

An author who wants cross-run state on a pipeline-declared memory slot sets a non-`:pipeline_run` scope at the pipeline level:

```ruby
memory :recent_incidents, strategy: :log, scope: :session, size: 10
```

This becomes available to sub-gens that declare a slot of the same name with the matching scope. Same primitive, different scope value. No new vocabulary.

---

## IR shape

A pipeline compiles to a top-level IR document with one entry per operator. Each operator references its sub-gen(s) by IR path (same pattern as `enrich`).

```json
{
  "kind": "Pipeline",
  "name": "CIReview",
  "entry": { "method": "review", "source": "app/pipelines/ci_review.pipeline.rb" },
  "input": {
    "pr": { "schema": "PullRequest" }
  },
  "policies": {
    "budget": { "tokens": 200000, "tool_calls": 200 },
    "security": { "_packs": ["research_defaults"], "network": { "allowlist": ["..."] } },
    "bind_defaults": "explicit"
  },
  "memory": [
    { "name": "findings", "strategy": "semantic", "top_k": 10, "scope": "pipeline_run" }
  ],
  "operators": [
    {
      "kind": "Step",
      "id": "recon",
      "gen": "SurfaceMapper",
      "method": "map",
      "ir_ref": "ir/surface_mapper.map.json",
      "with": [
        { "param": "ctx", "from": { "input": "pr" } }
      ]
    },
    {
      "kind": "FanOut",
      "id": "reviewers",
      "branches": [
        { "id": "security",      "agent": "SecurityReviewer",      "method": "review", "ir_ref": "ir/security_reviewer.review.json" },
        { "id": "architectural", "agent": "ArchitecturalReviewer", "method": "review", "ir_ref": "ir/architectural_reviewer.review.json" },
        { "id": "performance",   "agent": "PerformanceReviewer",   "method": "review", "ir_ref": "ir/performance_reviewer.review.json" },
        { "id": "semantic",      "agent": "SemanticReviewer",      "method": "review", "ir_ref": "ir/semantic_reviewer.review.json" }
      ],
      "concurrency": 4,
      "on_branch_failure": "continue",
      "require": { "kind": "all" },
      "pass_context": ["surface_map"],
      "collect_into": "reviews"
    },
    {
      "kind": "Step",
      "id": "fix",
      "gen": "Fixer",
      "method": "patch",
      "ir_ref": "ir/fixer.patch.json",
      "with": [
        { "param": "pr",      "from": { "input": "pr" } },
        { "param": "reviews", "from": { "step": "reviewers" } }
      ]
    }
  ],
  "output": { "kind": "last_step" }
}
```

`ir_ref` paths anchor to the workspace root. The compiler emits one IR file per referenced gen/method, the same way `enrich` does today. The runner loads them on demand when an operator fires.

The `_packs` metadata on `security` mirrors RED-214 — trace-only, no runtime branching on it.

---

## Trace shape

A pipeline run produces one trace tree. Each operator's sub-traces nest under it.

```json
{
  "type": "PipelineRun",
  "name": "CIReview",
  "ok": true,
  "started_at": "...",
  "finished_at": "...",
  "meta": {
    "total_tokens": 47312,
    "total_tool_calls": 18,
    "budget_cap_tokens": 200000,
    "operators_executed": 3
  },
  "operators": [
    {
      "type": "PipelineStep",
      "id": "recon",
      "ok": true,
      "trace": { "steps": [ "...full sub-trace..." ] }
    },
    {
      "type": "PipelineFanOut",
      "id": "reviewers",
      "ok": true,
      "meta": { "succeeded": 4, "failed": 0, "threshold": "all" },
      "branches": [
        { "branch_id": "security",      "ok": true, "trace": { "steps": [ "..." ] } },
        { "branch_id": "architectural", "ok": true, "trace": { "steps": [ "..." ] } },
        { "branch_id": "performance",   "ok": true, "trace": { "steps": [ "..." ] } },
        { "branch_id": "semantic",      "ok": true, "trace": { "steps": [ "..." ] } }
      ]
    },
    {
      "type": "PipelineStep",
      "id": "fix",
      "ok": true,
      "trace": { "steps": [ "...full sub-trace..." ] }
    }
  ]
}
```

Trace step types added by pipelines: `PipelineRun` (top), `PipelineStep`, `PipelineFanOut`. Per-branch state lives in `PipelineFanOut.branches[]` (no separate `PipelineBranch` wrapper type). Existing per-gen trace types (`Generate`, `Validate`, `Repair`, `Correct`, `Review`, etc.) nest unchanged inside each sub-trace.

Budget totals roll up at each level. The pipeline-level `meta.total_tokens` is the sum of all sub-gens' final token counts.

---

## Budget enforcement

The pipeline's `budget` block declares a single top-level cap (one for tokens, one for tool calls). Enforcement:

1. **Before each sub-gen dispatch**, the runtime checks `pipeline.tokens_so_far + projected_next_step <= pipeline.budget.tokens`. The projection is the next sub-gen's `max_tokens` from its own budget block (or a default if unset). If the check fails, the dispatch never happens — the pipeline terminates and emits `PipelineBudgetExceeded`.

2. **Per-step budgets enforce themselves independently.** A sub-gen exceeding its own per-run cap fails that step's gen-level Repair/Validate flow; the pipeline records the step failure and continues per the operator's failure semantics (`on_branch_failure :continue` for `fan_out`, terminate-the-pipeline for `step`).

3. **Cooperative cancellation.** When the pipeline cap is exceeded mid-fan-out, in-flight branches let their current tool call complete (tools are transactional); the next sub-gen turn never starts. Each cancelled branch emits a `BranchCancelled` trace entry; partial token/tool-call spend up to cancellation is recorded. No mid-tool aborts.

4. **Tool-call caps** roll up the same way. `budget tool_calls: 200` on the pipeline caps total across all sub-gens.

The pipeline budget IS NOT split among sub-gens implicitly. There is no "each step gets 1/N of the cap" logic. The cap is a ceiling, not a quota system. If the author wants per-step ceilings, they declare them on the sub-gens.

---

## Composition with existing primitives

- **`enrich`** — A sub-gen used in a pipeline step can still declare `enrich`; the enrichment runs inside that step's sub-transaction. The pipeline doesn't see the enrichment directly.
- **`compound :review` / `:consistency`** — Same. Sub-gens compose internally; the pipeline sees their final validated output.
- **`corrects`** — Each step's correctors run inside that step. The pipeline doesn't have its own corrector pipeline; if an author wants cross-step validation, that's a separate sub-gen, not a corrector.
- **`cron`** — Declared on a `Pipeline` class fires the whole pipeline on schedule. Same `--fired-by schedule:<id>` flow as gens. Falls out naturally.
- **`log`** — Declared on a `Pipeline` class emits events for the pipeline run + each operator + each sub-gen. Vocabulary extends the existing dot-notation. Same framework-owned enum stance.
- **`memory`** — See "Pipeline memory" section above. Sub-gens still own their per-gen memory; pipelines add an intra-run shared bucket on top.
- **`security` / `budget` (gen-level)** — Pipeline-declared policies inherit into sub-gens unless the sub-gen overrides per-slot. Same per-slot mixing rule as RED-214.
- **Signals / triggers** — Each sub-gen's signals fire its own triggers (tools, actions). Cross-step signal access is via `bind(:step_id).signal_name` in `branch_on`, `with:`, and the `output` block.
- **`mode :agentic` sub-gens** — Steps and branches can be agentic. Their tool budgets enforce inside the sub-gen; the pipeline's budget cap covers the sum.

---

## Out of scope (v1)

- **Model-decided routing.** No "let the LLM pick the next step." Pipelines are static DAGs. Authors who want model-decided routing build it as a single agentic gen with `mode :agentic` and tool calls.
- **Dynamic branch generation.** `fan_out from: ctx.classes` where the branch set comes from runtime data. v1 supports static branches plus an `enabled_when:` predicate (deterministic) per branch; runtime-determined branch sets defer.
- **Streaming partial pipeline output** to downstream consumers mid-run. v1 blocks on completion; streaming defers to v1.5.
- **Hierarchical pipelines** (a step that is itself a pipeline). Should compose naturally from the v1 primitive but not a v1 design target — the IR is pipeline-aware but the operator dispatch isn't yet recursive.
- **Resume / replay across steps.** Deferred but designed-for: v1 IR and trace are replay-adequate.
- **Cross-pipeline-run memory pools accessed from inside another pipeline.** Cross-run state stays in the existing scope vocabulary (`:session`, `:named_pool`); inter-pipeline coordination defers.

---

## Open questions for impl

These remain genuinely open and want resolution during the impl ticket (not before):

1. **Failure semantics for `branch_on`'s `default` block when nested operators fail.** The `default` block can itself contain `step` / `fan_out` calls; failure semantics inside the default need to match the rest of the pipeline. Most likely "same as a normal step sequence" but worth thinking through edge cases.
2. **`fan_out` branch budget projection.** When the pipeline's pre-dispatch budget check runs against a fan-out about to fire, the "projected next step" is N parallel sub-gens. Is the projection `sum of all branches' max_tokens`, or `concurrency * max_per_branch`, or something else? Conservative answer is `sum`; needs naming.
3. **Pipeline-level memory pruning.** When a pipeline declares `memory :findings, strategy: :semantic, top_k: 10, scope: :pipeline_run` and the run completes, what happens to the bucket file? Options: (a) deleted at pipeline end (intra-run only), (b) persisted under `runs/<run_id>/memory/` for replay/audit (preferred — falls out of replay-adequate design), (c) the v1.5 replay primitive decides.
4. **`cambium serve` per-pipeline endpoint shape.** The blocking-call response is straightforward (final output). Request shape: kwargs matching the pipeline's `input` block. Worth confirming when implementing.

---

## Relationship to existing primitives

The pipeline is the N-th primitive in the Cambium DSL, alongside:

- `enrich` — sub-gen before generate, single
- `compound` — sub-gen review/consistency after generate
- `cron` — declared schedule, framework-owned semantics, operator-owned lifecycle
- `log` — declared trace fan-out, framework-owned vocabulary
- `memory` — declared state with framework-owned strategies
- `security` / `budget` — policy declarations with per-slot mixing rules

Each follows the same Rails-y pattern: declarative, compile-time-validated, opinionated about scope, with one named primitive per concern. The pipeline extends this from intra-gen composition to **inter-gen composition** — same stance, broader scope.

The single piece of new vocabulary the pipeline introduces is the `Pipeline` class itself; everything else (`input`, `step`, `fan_out`, `branch_on`, `bind_defaults`, `output`, `bind(:input)`, `bind(:step_id)`, `:pipeline_run` scope) is a method on that class or an extension to existing primitive vocabulary.

---

## See also

- [[N - Agentic Transactions]] — names "parallel consensus" and "escalation chain" patterns; the pipeline primitive is the substrate for both.
- [[P - Compound Generation]] — `compound :consistency, passes: N` is fan-out's same-model cousin. `fan_out` generalizes to heterogeneous agents.
- [[P - enrich]] — sequential sub-agent composition before `generate`; `step` generalizes the same pattern across multiple gens.
- [[P - cron (schedule)]] — declares scheduled fire; extends naturally to pipelines.
- [[P - log]] — declares trace fan-out; extends naturally to pipelines with per-operator event names.
- [[P - Memory]] — adds the `:pipeline_run` scope keyword and the pipeline-authoritative-slot resolution pattern.
- [[P - Policy Packs (RED-214)]] — per-slot mixing rules that policy inheritance from pipeline → sub-gens follows.
- [[C - IR (Intermediate Representation)]] — the IR-as-truth model that makes both pipeline composition and replay tractable.
- [[C - Trace (observability)]] — trace structure that pipelines extend with nested per-operator sub-traces.
- [[C - Serve Mode]] — HTTP endpoint surface that pipelines extend symmetrically with gens.

---

This is the design note. Impl ticket follows once the four "open questions for impl" above settle, per the existing design-note-then-impl cadence (RED-273 → RED-305, RED-282 → RED-302, RED-296 → RED-298).
