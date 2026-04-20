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
- A corrector returning `corrected: false` with any `issues[]` entry of `severity: 'error'` feeds those issues into one additional repair attempt, then re-validates (`ValidateAfterCorrectorRepair`, RED-275). This lets correctors that can verify but not auto-fix (e.g. "does this regex match its own test cases?") drive the LLM to regenerate.
- A throwing corrector is caught by the pipeline and converted into a synthetic error issue — it does not terminate the run (RED-275).

## Example
```ruby
corrects :math, :dates, :currency
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
