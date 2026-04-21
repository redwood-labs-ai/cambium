# Primitive: corrects (correctors)

**Doc ID:** gen-dsl/primitive/corrects

## Purpose
Attach post-generation validators/repairers (correctors) such as math/date/currency normalization.

## Semantics (normative)
- Correctors MAY be implemented as:
  - deterministic validators
  - deterministic transformers
  - or constrained repair prompts that update only invalid fields
- Corrector outcomes MUST be represented in the trace.
- A corrector returning `corrected: true` with a modified `output` updates the pipeline value; the runtime re-validates against the schema afterwards (`ValidateAfterCorrect`).
- A corrector returning `corrected: false` with any `issues[]` entry of `severity: 'error'` feeds those issues into a repair attempt. After the repair passes schema re-validation (`ValidateAfterCorrectorRepair`), the runtime re-runs the same corrector on the repaired output (`CorrectAfterRepair`, RED-298) — this is the correctness fix that surfaces "did the repair actually heal the concern?" as an observable state rather than an implicit assumption.
- Each declared corrector carries its own `max_attempts` (default 1, ceiling 3, compile-time enforced). When `max_attempts` is exhausted with error-severity issues still pending, the runtime emits a terminal `CorrectAcceptedWithErrors` step (`ok: false`) so downstream consumers can refuse output on unhealed errors. The run itself does NOT fail — the output is schema-valid; policy "refuse on unhealed" is the caller's job.
- A throwing corrector is caught by the pipeline and converted into a synthetic error issue — it does not terminate the run (RED-275).

## Example
```ruby
corrects :math, :dates, :currency

# RED-298: opt a corrector into multi-attempt repair. `max_attempts` applies
# to every symbol in THIS call; separate calls carry separate budgets.
corrects :regex_compiles_and_tests_pass, max_attempts: 3
corrects :a, :b, max_attempts: 2         # both :a and :b get 2 attempts
corrects :a, max_attempts: 1
corrects :b, max_attempts: 3             # :a keeps 1, :b gets 3
```

## Built-in correctors
- `math` — recomputes `avg_*` / `sum_*` / `min_*` / `max_*` fields from sibling `*_samples` arrays.
- `dates` — normalizes date strings to ISO 8601.
- `currency` — normalizes currency amounts.
- `citations` — verifies `grounded_in` quote fidelity (auto-registered when `grounded_in` is declared; also usable directly).

## Custom app correctors (RED-275)

In [[N - App Mode vs Engine Mode (RED-220)|app-mode]] (workspace has a `Genfile.toml`), drop a file under `app/correctors/<name>.corrector.ts` exporting a function named `<name>`:

```ts
// app/correctors/regex_compiles_and_tests_pass.corrector.ts
import type { CorrectorFn } from '@cambium/runner';

export const regex_compiles_and_tests_pass: CorrectorFn = (data, _ctx) => {
  // data is the LLM's parsed output; verify, return issues if it fails.
  // ...
  return { corrected: false, output: data, issues };
};
```

Reference it from the gen:
```ruby
corrects :regex_compiles_and_tests_pass
```

Scaffold the boilerplate via `cambium new corrector <Name>` (RED-284) — the generated file lands in `app/correctors/` with the right filename convention and export shape.

The name must match `/^[a-z][a-z0-9_]*$/` (traversal guard). The export name must match the file basename. App correctors override same-named built-ins with a one-time stderr warning per process (mirrors the RED-209 tool-plugin precedence rule).

## See also
- [[C - Repair Loop]]
- [[N - Failure Modes & Debugging]]
- [[N - App Mode vs Engine Mode (RED-220)]]
