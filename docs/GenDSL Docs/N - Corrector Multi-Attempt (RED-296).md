## Note: Corrector Multi-Attempt Repair + DSL Contract Surface

**Doc ID:** gen-dsl/note/corrector-multi-attempt
**Status:** Shipped — RED-298
**Last edited:** 2026-04-20

---

## Purpose

[[P - corrects (correctors)]] + RED-275 wired app-level correctors into the repair loop with a hard cap of **one** additional generate attempt. That's the right v1 — bounded cost, predictable latency, easy to reason about. But the dogfood that motivated RED-275 (regex synthesis for secret-scanning patterns) also surfaced a pair of coupled problems the one-attempt contract doesn't cover:

1. **The current loop re-validates schema after repair, but does NOT re-run the corrector.** A corrector that says "this regex doesn't match its own test cases" gets its issues fed into Repair; Repair produces new output; the runner confirms the new output is schema-valid; the run succeeds. The corrector's actual concern is never re-checked. The framework reports "healed" when it only verified "still schema-shaped."

2. **Hard problems can survive a single repair attempt.** The concrete case (see [Grounding evidence](#grounding-evidence) below) was a JWT-secret regex where attempt 1 was simultaneously too narrow (missed `jwtSecret` casing) and too broad (matched commented-out lines); attempt 2 fixed the narrow part but still matched comments. A second repair would likely have healed it; a third, probably not needed.

This note settles the four questions RED-296 asks and produces an implementation ticket. It covers the corrector path only; Review / Consensus / grounding have their own repair semantics and are out of scope ([Out of scope](#out-of-scope)).

---

## Grounding evidence

`runs/run_20260420_170815_287802/trace.json` in `redwood-scanner/curator/` — the curator's JWT-secret regex synthesis gen under `omlx:Qwen3.5-27B-8bit @ temp 0.1`:

```
 0: SecurityCheck          ok=true
 1: Generate               ok=true
 2: Correct                ok=true  issues=2 errors=2
 3: Repair                 ok=true  attempt=3
 4: ValidateAfterCorrectorRepair  ok=true
(finalOk implied by chain)
```

Step 2's issues (both `severity: 'error'`):
- `test_cases.matching sample did NOT match (regex too narrow): "const config = { jwtSecret: \"abc123-this-is-real\" }"`
- `test_cases.non_matching sample DID match (regex too broad — likely false positive): "// const JWT_SECRET = \"supersecret-prod-key-do-not-commit\""`

Step 4's `ok: true` is **schema-only** re-validation. The repaired regex still matched the commented-out sample; the corrector would have returned the broadness error again, but it was never run. The curator's `bin/render.ts` has a belt-and-suspenders `verifyRegex` that caught it before ship — but that duplicates the corrector, violates DRY, and only works because this particular product wraps the framework.

---

## Decisions

### 1. Re-run the corrector after corrector-feedback Repair (correctness fix)

**Ship this regardless of whether the multi-attempt knob lands.** Today's `runner.ts:1054` only calls `handleValidate(repair.parsed, validate, 'ValidateAfterCorrectorRepair')`. That becomes:

1. `handleValidate` (schema) — unchanged.
2. If schema-valid: `runCorrectorPipeline` on the repaired output against the same corrector list; emit a new trace step `CorrectAfterRepair`.
3. If the re-run returns error-severity issues, that's the new "still-broken" state.

This converts "did we heal?" from an invisible question into an observable one.

### 2. `max_attempts` knob at the gen site, default 1, ceiling 3

**Per-gen knob.** Workspace policy is a follow-up, not v1.

```ruby
corrects :regex_compiles_and_tests_pass, max_attempts: 3
```

Compiled shape on the IR:

```json
{
  "policies": {
    "correctors": [
      { "name": "regex_compiles_and_tests_pass", "max_attempts": 3 }
    ]
  }
}
```

Back-compat: a bare symbol (`corrects :math, :dates, :currency`) compiles to `max_attempts: 1` — today's contract exactly. No existing gen changes shape.

**Default: 1.** Most corrector outcomes are deterministic (math recompute, date normalization, currency normalization) — there's no value in looping on them. The LLM-dependent correctors (regex verification, bespoke domain checks) are the ones that benefit from N > 1; the gen author opts in at the call site.

**Ceiling: 3.** Enforced at compile time. Rationale: attempt 1 catches most cases, attempt 2 covers "didn't understand the first feedback," attempt 3 is last-chance. Beyond 3 produces diminishing returns at monotonically increasing cost, and the gen author should be reaching for a stronger model or a different corrector shape, not a taller loop.

**Per-corrector, not per-decl.** `corrects :a, :b, max_attempts: 3` applies 3 to both. `corrects :a, max_attempts: 3; corrects :b` applies 3 to `:a` and 1 to `:b`. Matches Ruby's natural kwarg-at-end parsing.

### 3. New trace step type: `CorrectAcceptedWithErrors`

Terminal state when `max_attempts` exhausts and the corrector still returns error issues. Distinct from `CorrectAfterRepair` (intermediate re-run).

```json
{
  "type": "CorrectAcceptedWithErrors",
  "ok": false,
  "id": "correct_final",
  "meta": {
    "corrector": "regex_compiles_and_tests_pass",
    "attempts_made": 3,
    "unhealed_issues": [...]
  }
}
```

- `ok: false` so `jq '.steps[] | select(.ok == false)'` greps it.
- Emitted **once** per corrector that exhausted its budget — not once per failed attempt.
- Registered in [[C - Trace (observability)]] so it's documented alongside peers.
- Does **not** fail the run. The LLM's output is schema-valid; the runner's contract is "best-effort repair, report what we couldn't fix." Downstream consumers (like curator's `bin/render.ts`) read the trace and decide whether to accept.

### 4. No new budget axis; rely on existing `per_run` token cap

Worst case with `max_attempts: 3`: 1 initial Generate + 3 Repair attempts (each is a full LLM call with the failing issues as feedback). 4 model calls against what was 2 under N=1.

`policies.budget.per_run.max_tokens` already caps this. If the budget trips mid-loop, `BudgetExceededError` unwinds into `finalOk: false` exactly as it does today — documented as expected behavior. No new `corrector_max_tokens` axis. Gens that want tight cost control reach for the budget knob they already have.

---

## Rationale

### Why re-run is separate from the max-attempts knob

The re-run is a **correctness** fix. The current trace is misleading: it implies "corrector errors → Repair → ok." It should imply "corrector errors → Repair → re-check." Fixing that is a one-time change with zero new DSL surface; it ships even for gens that never touch `max_attempts`.

The max-attempts knob is an **ergonomics** knob. It's only useful if the re-run tells us whether to loop. Building them together is cleaner than sequencing them.

### Why not workspace-level policy in v1

Memory's workspace policy (RED-239, `app/config/memory_policy.rb`) exists because memory TTLs have real security + storage-cost dimensions that operators need to police across gens. Corrector loops don't — they cost LLM tokens, which is the `budget` primitive's job. There's no compliance or security angle that compels a shop-wide "max_attempts must be ≤ 2" rule.

If a forcing use case shows up (e.g., a shop with ten regex-synthesis gens and someone wants to dial them all to 3 without editing each one), a follow-up ticket can add `app/config/corrector_policy.rb` with the same precedence shape memory policy uses (workspace ceiling; per-gen decl can only go lower). Not needed in v1.

### Why ceiling 3, enforced at compile time

Consistent with RED-239 memory TTL's `MAX_TTL_SECONDS` stance: Rails-style opinionated defaults that protect unsuspecting authors. A gen author who writes `max_attempts: 99` in frustration gets a clear compile error with the reason, not a 99-iteration run that burns their token budget silently.

Compile-time enforcement means the constraint is visible in the Ruby diagnostic, not buried in a runner trace step. The ceiling itself is easy to lift later if anyone surfaces a case that needs it.

---

## Rejected alternatives

- **Per-corrector default in the corrector file.** Floated in the ticket. Rejected: correctors are plain functions (`CorrectorFn`), and adding a config surface (e.g., `export const metadata = { max_attempts: 3 }`) would make them the first module-level-config point in the corrector system. Cambium's stance is "declaration at the use site"; the gen author choosing `max_attempts` is consistent with that.

- **Loop schema-repair and corrector-repair together.** Today, schema repair has its own internal attempt counter (`maxRepairAttempts`, default 2) inside `handleRepair`. Corrector repair is a separate call. A unified loop would merge them — but schema-repair semantics are "the LLM produced garbage, try again verbatim" while corrector-repair semantics are "the LLM produced valid garbage, try again with domain feedback." Different prompts, different success criteria. Keeping them structurally separate matches the current step names and is easier to reason about in the trace.

- **Emit a separate trace step per failed re-run attempt.** Considered for finer-grained observability; rejected as noise. The `Repair` + `CorrectAfterRepair` pair already names each iteration; a terminal `CorrectAcceptedWithErrors` summarizes the final state. Intermediate failures are visible in the per-iteration `CorrectAfterRepair ok: false` chain.

- **Make `CorrectAcceptedWithErrors` fail the run.** Considered: "if the corrector can't heal, the framework should refuse to return." Rejected: the output *is* schema-valid, and some gens legitimately want best-effort-then-report behavior (curator's pattern: let the framework try, let the downstream consumer veto with domain logic). Making refusal the default would break that shape. If a gen wants strict behavior, it can inspect the trace or wire a downstream guard — same as today.

---

## Implementation sketch

Shipped as RED-298 with the shape below:

### Ruby DSL (`ruby/cambium/runtime.rb`)

Extend `corrects` to accept a trailing kwarg:

```ruby
def corrects(*names, max_attempts: 1)
  # validation: max_attempts in 1..3, integer
  # normalize names into [{ name: Symbol, max_attempts: Integer }, ...]
end
```

### IR shape (`ruby/cambium/compile.rb`)

`policies.correctors` becomes an array of `{ name, max_attempts }` objects instead of a bare array of strings. Normalize old-style symbol arrays to `{ name: 'x', max_attempts: 1 }` for backward compatibility during the rollout window.

### Runner (`packages/cambium-runner/src/runner.ts`)

Rework the block at runner.ts:1031–1062 into a loop bounded by each corrector's `max_attempts`:

```
for each corrector in policies.correctors:
  attempts_made = 0
  while attempts_made < corrector.max_attempts:
    errors = current corrector pass's error-severity issues
    if errors.empty: break
    attempts_made += 1
    repair = handleRepair(…, corrector-feedback errors, …)
    pushRepairStep(repair)
    if repair.parsed:
      revalidate = handleValidate(repair.parsed, validate, 'ValidateAfterCorrectorRepair')
      trace.steps.push(revalidate)
      if not revalidate.ok: break  # schema broke; keep pre-repair parsed
      parsed = repair.parsed
      correct_rerun = runCorrectorPipeline([corrector.name], parsed, ctx)
      trace.steps.push({ type: 'CorrectAfterRepair', …, meta: correct_rerun.results })
  if attempts_made == max_attempts AND errors still exist:
    trace.steps.push({ type: 'CorrectAcceptedWithErrors', ok: false, … })
```

Scoped to one corrector at a time so trace reads naturally. Budget enforcement unchanged — `pushRepairStep` already tracks tokens via `budgetTrack`.

### Tests (`packages/cambium-runner/src/corrector-feedback.test.ts`)

Parametric extension of the existing test file:
- `max_attempts: 1` (default) — existing assertions unchanged.
- `max_attempts: 3` + corrector that always fails — expect 3 `Repair` + 3 `CorrectAfterRepair` + 1 `CorrectAcceptedWithErrors`.
- `max_attempts: 3` + corrector that fails twice then heals — expect 2 `Repair` + 2 `CorrectAfterRepair` + final clean state, no `CorrectAcceptedWithErrors`.
- `max_attempts: 3` + budget cap that trips mid-loop — expect `BudgetExceededError` → `finalOk: false`.

### Docs

- [[P - corrects (correctors)]] — document the kwarg and the new terminal-state step.
- [[C - Trace (observability)]] — add `CorrectAfterRepair` and `CorrectAcceptedWithErrors` rows.
- [[C - Repair Loop]] — update the loop description.
- `CLAUDE.md` "Pipeline structure" invariant for RED-275 gets an amendment: "Corrector re-run after repair is a correctness invariant; a `CorrectAfterRepair` step MUST follow every `ValidateAfterCorrectorRepair` that passed schema validation."

---

## Out of scope

- **Generalization to Review / Consensus / grounding repair paths.** Each has its own repair semantics and its own `max_attempts` question (if any). This note is corrector-specific by the ticket's explicit scope.
- **Workspace-level corrector policy.** Deferred to a future ticket if/when a forcing use case surfaces. Matches the RED-241 / RED-273 / RED-281 / RED-282 design-note-deferred stance.
- **Per-corrector-file config surface.** Rejected above; if a future case needs module-level knobs, that's a separate design discussion.
- **Retry strategy variants** (exponential backoff between attempts, different prompts per attempt, temperature schedule). v1 is uniform-retry; sophistication can layer on later.

---

## See also

- [[P - corrects (correctors)]]
- [[C - Repair Loop]]
- [[C - Trace (observability)]]
- [[N - Failure Modes & Debugging]]
- RED-275 (the original one-attempt contract)
- RED-239 (workspace memory policy — precedent for workspace-level corrector policy if/when added)
