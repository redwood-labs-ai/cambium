# Generation Engineering DSL (Rails-style) — Spec Draft

**Goal:** “Rails for generation engineering.” Make LLM programs boringly reliable via conventions: typed outputs, grounding, tool permissions, validation + repair loops, and auditability.

This is a *DSL and runtime*, not “a pile of prompts.” The prompt is just one step inside a governed execution plan.

---

## Design Principles

### Convention over configuration
Default to the safe/happy path:
- `generate → validate → repair (N times) → fail with trace`
- grounded outputs when grounding is enabled
- schema-validated return types
- tool access must be explicitly declared

### Programs with contracts
A `generate` call is a **transaction** with:
- deterministic preprocessing (context packing + retrieval)
- typed output target (schema)
- post-checks + repair strategy
- provenance (citations/spans)
- telemetry + trace (tokens, latency, cost, tool calls)

### Separate concerns
- **Authoring** should be readable (Ruby/Rails feel)
- **Execution** should be portable + instrumented (Node/TS runtime)
- **Truth** should be a compiled plan (IR) that can be audited/replayed

---

## Proposed Architecture (Phase 1)

### Authoring: Ruby DSL → Compiled IR
- Files authored in Ruby-like DSL ("reads like English")
- Compiler produces **JSON IR** (intermediate representation) describing an execution graph/plan

### Execution: TypeScript/Node runtime
- Runner executes IR steps:
  - Retrieval
  - Prompt/model generation
  - Tool calls
  - Validation
  - Repair loops
  - Return
- Instrumentation baked in (OpenTelemetry-ready)

**Rationale:** Avoid inventing a new language runtime day-1; ship the value (contracts + governance). If we later invent a standalone language, it should compile to the same IR.

---

## Rails-Style App Structure (Enterprise-friendly)

Target: avoid “2,000-line script” by default.

Suggested layout:
```
app/
  gens/            # GenModel classes (DSL)
  schemas/         # JSON Schemas for typed returns
  grounding/       # corpora / access rules / retrieval policies
  tools/           # tool definitions + input/output schemas
  correctors/      # validators + repair strategies
config/
  gen.yml          # defaults (model, retries, tracing, etc.)
```

Optional generators later:
- `gen new model Analyst`
- `gen new schema AnalysisReport`
- `gen new tool calculator`

---

## Core DSL Primitives

### Model + policies
```ruby
class Analyst < GenModel
  base_model "llama3:70b"
  temperature 0.2
  max_tokens 2000

  grounded_in :company_docs
  uses :vector_search, :calculator
  corrects :math, :dates, :currency

  constrain :tone, to: :professional
  returns AnalysisReport
end
```

### Generate transaction
```ruby
def analyze(document)
  generate "analyze this document" do
    with context: document
    require_citations!
    returns AnalysisReport
  end
end
```

**Semantics:** `generate` compiles to a plan with explicit steps, not an opaque single model call.

---

## Tools Primitive (The Unlock)

Declaring tools is how LLM programs become *systems*.

### Tool declaration (concept)
- tools are declared as capabilities:
  - permissioned (policy)
  - typed (schema)
  - logged (audit)
  - replayable-ish (traceable inputs/outputs)

Example:
```ruby
uses :calculator
```

Runtime guarantees:
- no undeclared tool calls
- tool invocations stored in trace with structured I/O

---

## Correctors (Validation + Repair)

`corrects :math, :dates, :currency` should map to a **pipeline**:
- detectors: did the output contain numbers/dates/currency fields?
- validators: parse + check invariants
- repair strategy:
  - deterministic fix when possible (calculator, parsing)
  - otherwise constrained re-ask ("repair only the invalid fields")

Examples:
- `:dates` => enforce ISO-8601; ensure date claim exists in context or mark unknown
- `:currency` => normalize currency codes + formatting; optionally convert with trusted FX source
- `:math` => recompute expressions; reject mismatches

---

## Typed Returns

`returns AnalysisReport` means:
- output must validate against `schemas/analysis_report.json`
- required fields must be present
- any claim fields must either:
  - cite sources, or
  - explicitly state `unknown` (configurable policy)

**This is the “Rails schema” equivalent.** It forces honesty and makes downstream consumption safe.

---

## Grounding + Provenance

When `grounded_in :company_docs` is enabled:
- retrieval step produces a context bundle
- model output must include citations for configured fields
- citations map to:
  - doc id
  - span offsets (or chunk ids)
  - quoted text (optional)

Goal: answer + evidence are inseparable.

---

## IR (Intermediate Representation) — Sketch

IR is a JSON graph/plan of steps. Example step types:
- `Retrieve { corpus, query, k }`
- `Generate { model, system, user, context, schema }`
- `ToolCall { tool, inputSchema, outputSchema }`
- `Validate { schema, policies }`
- `Repair { strategy, maxAttempts }`
- `Return { value }`

**Key property:** IR is auditable, replayable, and portable across runtimes.

---

## Observability / Trace

Every run yields a trace:
- prompt + context hashes (and optionally raw)
- tool calls + I/O
- validation errors
- repair attempts
- token counts, latency, cost
- final output + schema version

This is the debugging and enterprise compliance story.

---

## MVP Definition (v0)

Ship the smallest thing that proves the thesis:
1) Ruby DSL that can define a `GenModel` and a `generate` transaction
2) JSON-schema returns with AJV validation
3) A tool registry with at least one tool (`calculator`)
4) Repair loop (2 attempts) that only edits invalid fields
5) Trace output (JSON)

One demo:
- `Analyst#analyze(document) → AnalysisReport` with citations + math correction.

---

## Open Questions
- Do we want inline TS type blocks (Svelte-style) or schema files first?
- How strict should grounding be by default (hard fail vs “unknown allowed”)?
- How do we package + version corpora/retrievers ("grounding migrations")?
- Security model for tools (sandboxing, network allowlists, secrets access)?

---

## Next Steps
- Write IR JSON schema (first-class spec)
- Stub Ruby DSL compiler → IR emitter
- Build TS runner skeleton + tool registry
- Define 3 built-in correctors: math, dates, currency
- Add an example Rails-ish project layout + generator stubs
