# RFC 0001 — Opinionated Agentic Infrastructure (Cambium)

**Status:** Draft

**Author:** Steve Keider (+ Jenkins)

**Audience:** CTO / architecture review (highly technical)

**Motivation:** Build agentic systems for mission‑critical domains (financial operations, legacy/inheritance, compliance) where **"prompting the model harder"** is not an acceptable reliability strategy.

---

## 0. Executive summary
LLMs are not reliable authorities. They are probabilistic text synthesizers.

If we want *tracer‑bullet precision* in agentic products (especially in finance / wealth transfer / inheritance), determinism must come from **infrastructure**, not from the model:

- **Deterministic control plane**: typed IR, policy engine, tool sandboxing, budgets, approvals
- **Nondeterministic data plane**: LLM produces drafts within strict envelopes (schemas)
- **Fail closed**: on ambiguity/invalid output, stop and escalate; do not hallucinate to “keep the loop moving”
- **Auditability by construction**: every step/tool call/decision is traced and replayable

This is analogous to what Rails did for web apps: opinionated defaults + hard boundaries produce predictable, maintainable systems.

---

## 1. Background and framing
### 1.1 The problem with “deterministic LLM output”
When teams say they want deterministic output, they typically mean some mix of:

1) **Deterministic structure** (always valid JSON, always conforms to schema)
2) **Deterministic decisions** (same inputs → same allowed/blocked actions)
3) **Deterministic side effects** (no surprise network calls, no surprise state mutations)
4) **Deterministic audit trail** (“why did it do that?” has a crisp answer)

LLMs can help with (1) *when constrained*, but cannot be trusted as the foundation for (2)-(4).

Even if a model *often* behaves well, mission‑critical domains must assume:
- prompt compliance is conditional
- tool selection can drift
- refusal/ignore behavior can change across versions
- a “good” behavior might only happen once in a loop

So the model cannot be the system’s governor.

### 1.2 The core idea
**Cambium treats the LLM like a component, not an authority.**

- The **runner** is authoritative: it executes a typed plan (IR), enforces policy, controls tools, tracks budgets, validates outputs, and writes traces.
- The LLM is a bounded function: given context and strict output constraints, it proposes the next structured step or produces user-facing language.

### 1.3 Generation engineering: turning probabilistic components into deterministic outcomes
A useful mental model is **generation engineering**:

> Deterministic systems design around nondeterministic components.

We do not need the model to be correct 100% of the time to achieve production-grade reliability.
We need:
- deterministic *contracts* (schemas)
- deterministic *gates* (policy/permissions)
- deterministic *termination* (budgets)
- deterministic *side effects* (two-phase commit)
- deterministic *evidence* (trace)

Analogy: a coin flip is probabilistic, but a *system* can deliver “heads” deterministically by retrying until success (within a bounded budget) and failing closed when the budget is exhausted.

In LLM terms, “retry until heads” maps to bounded repair/re-ask loops, while the runner prevents retries from becoming an unbounded incident (tokens/tools/bad side effects).

---

## 2. Rails analogy: opinionated software, not “vibe coding”
This is not “Ruby is token-efficient” energy.

The design goal is to recover the *Rails* experience: conventions and boundaries that make the correct path the easy path.

Rails primitives and their agentic analogs:

- **Migrations / schema** → IR + JSON schemas as the system’s contract
- **Validations / strong params** → runtime validation + repair policy (and fail-closed behavior)
- **Controller filters** → tool allowlists + policy gates
- **Transactions** → two-phase commit for irreversible actions
- **Logs + instrumentation** → structured trace as first-class artifact
- **Feature flags / config** → runtime control-plane overlays (see Operational Bulletins)

The claim:
> The fastest way to build reliable agentic systems is to be opinionated about the rails they run on.

---

## 3. Architecture overview
### 3.1 Two planes: control vs data

**Control Plane (deterministic)**
- IR graph / step plan
- Tool registry and capability permissions
- Policy engine (what is allowed, when)
- Budget accounting (turns, tool calls)
- Validation + repair strategies
- Approval gates
- Operational bulletins (incident control overlay)

**Data Plane (probabilistic)**
- LLM generation: draft text, produce structured JSON within constraints

The boundary is intentional: the LLM cannot directly create side effects.

### 3.2 Execution model
High-level loop:

1) Runner selects next IR step
2) Runner builds prompt with strict schema constraints + relevant context
3) LLM returns structured output
4) Runner validates output
   - if valid: continue
   - if invalid: repair (bounded) or fail closed
5) If tool calls are requested: runner executes them via registry
6) Runner records trace for everything

---

## 4. Key primitives (Cambium)
### 4.1 IR: a typed “program” for the agent
Rather than “a chat,” we execute a typed graph:
- explicit steps
- typed inputs/outputs
- policies attached to nodes

This transforms “agent behavior” from emergent text into something you can reason about.

### 4.2 Schema validation + repair (but never hallucinate)
Schema validation ensures deterministic structure.

Repair is allowed only within strict constraints:
- JSON only
- only fix what validation errors require
- **do not introduce new factual content**
- if information is missing, leave fields empty

Critically, when the model returns tool-call markup or other non-JSON artifacts during repair, the system should **fail closed** rather than manufacture placeholder answers.

### 4.3 Tool registry + permissions (capabilities)
Tools must be:
- explicitly registered
- typed
- allowlisted per workflow/step
- traced

No “free” file/network access from within the model.

### 4.4 Budgets
Budgets constrain blast radius:
- max turns
- max tool calls
- max tokens per phase

Budgets should be accounted for **agentic tool calls** (not just “normal” tool calls) so limits actually limit.

### 4.5 Two-phase commit for irreversible actions
For anything with irreversible side effects (moving funds, changing beneficiaries, sending comms):

**Phase 1: Propose**
- produce a transaction bundle: intent + parameters + justification + citations

**Phase 2: Approve/Execute**
- approval gate (human/compliance/policy)
- execution via tool registry

This makes “LLM mistakes” non-fatal by default.

### 4.6 Operational Bulletins (control-plane overlay)
Operational Bulletins are a runtime mechanism to steer/override behavior during incidents without relying on the model.

Properties:
- fetched out-of-band by runner (0 tokens)
- deterministically matched for relevance
- enforced at tool router / step controller
- delivered at reliable seams (post-tool/post-step) so they can arrive mid-session
- non-spammy via session ack/mute with TTL

See: `docs/bulletins.md`.

---

## 5. Example workflow: “legacy transfer” with tracer-bullet precision
### 5.1 Desired property
No step should proceed based on model “confidence.” The system proceeds only when the contract is satisfied.

### 5.2 Sketch
**Inputs:** user goal, identities, legal documents (trust/will), account state, jurisdiction

**Flow:**
1) Collect facts (tool calls)
2) Ground all claims (citations)
3) Produce structured plan JSON (schema)
4) Validate plan against policy engine (eligibility)
5) Present for approval (human/compliance)
6) Execute via tool registry (two-phase commit)
7) Emit trace artifact suitable for audit

**Failure mode:** If anything is missing/ambiguous, fail closed → ask targeted questions.

---

## 6. Why this is strategically relevant for a Bitcoin financial services company
Agentic products in finance are attractive, but the market will punish:
- un-auditable behavior
- silent failures
- irreversible actions from “creative” systems

A deterministic runner + opinionated workflow primitives are a defensible differentiator.

---

## 7. Open questions / next decisions
1) What is the minimal IR subset to standardize for “mission-critical” workflows?
2) What are the default tool capability tiers (read-only vs mutating vs comms)?
3) What are the approval gate semantics (human vs policy vs both)?
4) Trace format: what is the canonical artifact (JSON, OpenTelemetry, both)?
5) How do we define/encode policy (declarative constraints vs code)?

---

## Appendix A — Notes on Yan Pritzker context (why this framing should land)
Yan’s background (former Reverb CTO, Rails experience) suggests the Rails analogy is not rhetorical — it targets a shared intuition:
- mission-critical systems are reliable because the framework enforces shape
- “convention over configuration” reduces risk
- the happy path should be the safe path

---

## Appendix B — Implementation pointers (where this lives in Cambium)
- Runner responsibilities: `docs/GenDSL Docs/C - Runner (TS runtime).md`
- Tool registry: `docs/GenDSL Docs/D - Tools Registry.md`
- Operational Bulletins spec: `docs/bulletins.md`
