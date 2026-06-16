# Golden Tests — regression testing for LLM programs

**Doc ID:** gen-dsl/tooling/golden-tests

## Purpose

Pin a gen's outputs against a committed snapshot so that a schema change, corrector tweak, or prompt edit that silently shifts the shape of the output fails loudly in CI — without calling the LLM on every test run.

The core insight: **the mock provider (`--mock`) is deterministic and free**. A gen run with `--mock` produces the same output every time from the same IR. Once you have a snapshot you trust, every subsequent regression run replays the cheap deterministic path. When you intentionally change the output shape, update the snapshot and commit; that commit is the approval record.

The golden-test engine (`golden.ts`, RED-140) is a utility library — it is **not** a DSL primitive and does not add a new IR field or trace step. It lives on the test side, not the gen side.

## API

```ts
import {
  goldenTest,
  formatGoldenFailure,
  stripCitations,
  normalizeNumbers,
  normalizeStrings,
  normalizeDates,
} from '@redwood-labs/cambium-runner';
import type { DiffEntry, GoldenTestOptions, GoldenTestResult } from '@redwood-labs/cambium-runner';
```

### `goldenTest(actual, expected, options?): GoldenTestResult`

Compares `actual` output against `expected` snapshot with field-level diffs.

```ts
type GoldenTestOptions = {
  /** Fields to skip (dot/bracket paths; `[*]` wildcard for array elements). */
  ignoreFields?: string[];
  /** Applied to both actual and expected before comparison. */
  normalizers?: Array<(obj: any) => any>;
  /** Allowed absolute deviation for numeric fields (default: 0). */
  numberTolerance?: number;
  /** Only check that expected fields exist in actual (superset check). */
  supersetOnly?: boolean;
};

type GoldenTestResult = {
  passed: boolean;
  diffs: DiffEntry[];
  summary: string; // human-readable; use in expect(passed, summary).toBe(true)
};
```

Returns a result object — it does **not** throw. Call `expect(result.passed, result.summary).toBe(true)` to turn a diff into a test failure with a readable message.

### Built-in normalizers

| Normalizer | What it does |
|---|---|
| `normalizeStrings` | Trim + collapse whitespace in all string values |
| `normalizeNumbers` | Round all numbers to N decimal places (default 2) |
| `normalizeDates` | Collapse `YYYY-MM-DDTHH:MM:SSZ` ISO timestamps to `YYYY-MM-DD` |
| `stripCitations` | Remove all `citations` keys from the object tree |

Normalizers apply to **both** actual and expected before comparison, so snapshot files can use any normal form.

### `formatGoldenFailure(result, label?): string`

Formats a `GoldenTestResult` as a human-readable error message. Useful when building custom assertion wrappers.

## The regression-testing workflow

```
 first run                 CI (every commit after)
 ─────────────             ──────────────────────
 write gen + fixture   →   npm test (--mock, zero tokens)
 cambium run --mock    →   goldenTest(actual, snapshot)
 commit output.json        ✓ or diff → fix → update snapshot
 as <name>-snapshot.json
```

### Step 1: create a fixture

Put representative input in `examples/fixtures/<name>.txt` (or `.json`, `.md`). This is the document the gen will process. Commit it.

### Step 2: produce a snapshot

Run the gen in mock mode to generate a deterministic output:

```bash
cambium run packages/cambium/app/gens/<name>.cmb.rb \
  --method analyze \
  --arg packages/cambium/examples/fixtures/<name>.txt \
  --mock
```

The run writes `runs/<id>/output.json`. Copy it to `examples/fixtures/<name>-snapshot.json` and commit. This snapshot is now the approved expected output.

### Step 3: write the test

`cambium new agent <Name>` scaffolds this automatically. The generated test:

- Compiles the gen to IR (fast, no LLM).
- Runs with `--mock` (deterministic, free).
- Reads the committed snapshot.
- Calls `goldenTest(actual, expected, { normalizers: [normalizeStrings] })`.
- Skips gracefully if the fixture or snapshot is not yet committed (warning, not failure).

### Step 4: update the snapshot when the output intentionally changes

```bash
cambium run ... --mock
cp runs/<id>/output.json examples/fixtures/<name>-snapshot.json
git add examples/fixtures/<name>-snapshot.json
git commit -m "update <name> golden snapshot — <why>"
```

The commit message is the approval record.

## `cambium replay` and golden tests

`cambium replay <run-id> --mock` re-runs the post-Generate tail (validate → correct → repair → grounding) against a prior run's recorded output, skipping Generate entirely. This is useful when you want to iterate on correctors or grounding rules without touching the snapshot:

```bash
# iterate on a corrector without burning tokens or updating the snapshot
cambium replay <run-id> --mock
```

When the output of the tail changes in a way you want to pin, capture the new `output.json` and update the snapshot.

## Selecting normalizers and tolerances

Match the normalizer to what varies in mock output but should not constitute a real regression:

| Schema concern | Use |
|---|---|
| Prose / LLM-generated strings with variable whitespace | `normalizeStrings` |
| Floating-point recomputed fields (math corrector) | `numberTolerance: 0.01` or `normalizeNumbers` |
| ISO timestamps (the mock produces the same value, but real runs vary) | `normalizeDates` |
| Citations (present in live runs, absent in mock or not under test) | `stripCitations` or `ignoreFields: ['citations']` |
| Run-level metadata (run_id, timestamps) | `ignoreFields: ['run_id', 'generated_at']` |
| Array elements whose citation quotes may drift | `ignoreFields: ['items[*].quote']` |

Use `supersetOnly: true` when you only want to assert that the expected keys exist and have the right values, ignoring any additional fields the gen produces.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `passed: false` with `type: 'changed'` | Output value drifted from snapshot | Intentional: update snapshot. Unintentional: find the regression in the gen/corrector. |
| `type: 'missing'` | Expected field absent from actual | Schema narrowed or field renamed — update gen or snapshot. |
| `type: 'extra'` | Actual has fields not in snapshot | Schema widened — update snapshot or switch to `supersetOnly: true` if extras are acceptable. |
| `type: 'type_mismatch'` | Field type changed | Usually a schema-block change in `returns do` — review and update snapshot. |
| Test warns "fixture not found" | `FIXTURE` path in the test doesn't exist yet | Create `examples/fixtures/<name>.txt`. |
| Test warns "snapshot not found" | `<name>-snapshot.json` not committed | Run once with `--mock`, copy `output.json`, commit. |
| Numbers off by a rounding error | Math corrector applies fixed precision | Add `numberTolerance: 0.01` or `normalizeNumbers` to the test. |

## What this is not

- **Not a DSL primitive.** `goldenTest` is a test-side library function. It adds no IR field, no trace step, no new `returns` or `corrects` declaration.
- **Not an eval harness.** This is regression testing against a committed snapshot, not accuracy scoring against a rubric. For LLM evaluation (RED-384, 1.1), see the design note when it ships.
- **Not a replay primitive.** `cambium replay` is a separate CLI verb (see `P - cambium replay`); golden tests use it as one of several ways to produce deterministic output for comparison.

## See also

- [[P - cambium replay]] — re-run a prior run's post-Generate tail without re-calling the LLM
- [[P - returns]] — `returns do … end` block schema; the schema the mock validates against
- [[C - Trace (observability)]] — `runs/<id>/` artifact layout (ir.json, output.json, trace.json)
- [[P - corrects (correctors)]] — correctors that the replay tail exercises
