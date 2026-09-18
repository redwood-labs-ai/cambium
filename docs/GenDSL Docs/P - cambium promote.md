# Primitive: cambium promote

**Doc ID:** gen-dsl/primitive/cambium-promote

## Purpose

Close the last manual rung of the accretion loop — run → trace → fixture → golden test → corrector. Turning a real run (usually a failure fixed in the field) into permanent regression armor today means hand-copying an input document into `examples/fixtures/`, hand-copying (or re-deriving) an expected output into a snapshot, and hand-wiring a test file to both. `cambium promote <run-id|path>` does all three in one move, and proves the result works before it exits: the golden test it produces (or updates) passes immediately.

## Surface

```bash
cambium promote <run-id>                         # bare id, resolved under <cwd>/runs/
cambium promote runs/run_2026...                 # path form also accepted
cambium promote <run-id> --source <key>          # disambiguate when ir.context has 0 or >1 eligible keys
cambium promote <run-id> --force                 # overwrite an existing fixture/snapshot
```

Argument shape mirrors `cambium replay`'s `<run-id|path>` contract deliberately — the same run reference works with both verbs.

## Semantics (normative)

- **What gets promoted.** The run's input document, read from `runs/<id>/ir.json`'s `context` object (the raw `--arg` path is never recorded anywhere, so the IR's baked-in copy is the only source). Eligible keys are string-valued and not `_`-prefixed. Exactly one eligible key promotes automatically; zero or more than one requires `--source <key>` (which may also name a `_`-prefixed or non-string key explicitly — non-string values are serialized as pretty-printed JSON). The fixture's extension is sniffed from content: valid JSON (object or array, after trim) → `.json`, otherwise `.txt`.
- **Snapshot provenance — mint, never copy.** Promote does **not** copy the source run's `output.json` into the snapshot. It writes the fixture first, then spawns a fresh `cambium run <the gen> --method <the method> --arg <the just-promoted fixture> --mock` and snapshots **that run's stdout**. This is deliberate: the golden test always asserts under `--mock`, and mock output is schema-derived, not content-derived. A copied snapshot from a **real** (non-mock) source run can never equal what the golden compares against on its first execution — the exact case that motivates this feature (a failure fixed in the field is, by definition, not a mock run). Minting instead of copying also means:
  - A **failed run** (a run whose `ir.json` exists but `output.json` doesn't — Generate never completed, or a later step crashed) is still promotable. Only `ir.json` is required.
  - For a `--mock` source run, mint and copy are identical (mock is deterministic) — nothing is lost in the common case either.
- **Target paths (fixed, not configurable).** Given a gen class `Foo` and promoted context key `doc`:
  - Fixture: `<app>/examples/fixtures/foo-promoted-doc.<ext>`
  - Snapshot: `<app>/examples/fixtures/foo-snapshot.json` — the same location `cambium new agent`'s scaffolded test already points at. One snapshot per gen (the existing regression-test model), not one per run; a re-promote is an intentional snapshot refresh, gated by `--force`.
  - Test: `<app>/tests/foo.test.ts`
- **Test wiring — three cases, and a hard rule.** Promote never rewrites a test file once it's wired:
  1. **Absent** → scaffolds a fresh test from the same template `cambium new agent` uses (`goldenTestSource`), with the real method and the real fixture path substituted for the scaffold's `analyze` default and TODO placeholder. The `GEN` constant is derived from *this run's own validated `entry.source`*, not the `<app>/app/gens/<snake(class)>.cmb.rb` naming convention — a relocated or renamed gen still gets a golden that runs the right file.
  2. **Present, still carrying the scaffold's literal TODO placeholder** → replaces only the `const FIXTURE = …` line's value. Nothing else in the file is touched — including its `GEN` line.
  3. **Present and already wired** (no placeholder) → left byte-identical. Promote prints the wired `FIXTURE` line and notes whether it matches what was just promoted, but makes no edit. `--force` does **not** override this — it governs only the machine-owned fixture/snapshot files, never a test file a human may have hand-edited (every real golden in this repo is an edited scaffold; wholesale regeneration would be unrecoverable data loss).

  For cases 2 and 3, promote compares the existing test's `GEN` line against this run's `entry.source` and prints a visible `WARNING` (naming both paths) on a mismatch — it still never edits the line. A mismatch means the wired test runs a different file than the one that actually produced the just-minted snapshot; the fix is a human decision (edit `GEN` by hand, or promote a run against the gen the test already points at), not a promote flag.
- **Overwrite protection — all-or-nothing preflight.** Before writing anything, promote computes every target path and checks for collisions. Any collision (fixture or snapshot already exists) without `--force` refuses the whole operation — nothing is written, not even the non-colliding targets. With `--force`, the fixture and snapshot are overwritten; the test file still follows its own three-case rule above.
- **Layout scope.** Promote resolves `<app>` exactly the way `cambium new` does — both RED-286 layouts (`[workspace]` monorepo, `[package]` flat) work. Engine mode is refused (no `examples/fixtures/`/`tests/` convention to write into) and named in the error.
- **Gens only.** A Pipeline run (`ir.json`'s shape lacks a gen's `entry.class` + `steps[]`) is refused, citing the gens-first non-goal. Pipeline-run promotion is deliberately out of scope; if it ships, it's an additive follow-up.

### Known limitation (inherited from context extraction, DEC-002)

The promoted fixture is whatever the run's context held at Generate time — if a gen's method transforms its `--arg` before calling `with context:`, promote captures the *transformed* value, not the raw original input. The golden still passes (mock output is schema-derived, not content-derived), so this doesn't break the feature; it just means the fixture on disk may not literally be the file an operator originally passed with `--arg`. The common scaffold shape (`def analyze(document) … with context: document`) is an identity transform, so this doesn't bite the default case. Recording the raw `--arg` into the run directory itself (rather than reading it back out of `ir.context`) would remove this limitation entirely and is a straightforward additive follow-up if it ever does.

## Trust boundary

**Only promote run directories you generated yourself or otherwise trust.** The path form of `<run-id|path>` can name any directory on disk — including one an operator did not generate locally: received from a teammate, downloaded from CI, attached to a bug report. That's exactly the "field failure" story that motivates this feature, so promote treats the run directory's `ir.json` as untrusted input, the same way a precompiled IR artifact is treated as untrusted by `cambium run --ir` / `cambium serve --precompiled` (`assertGenIr`, #195) — but the checks here are promote-specific, not a reuse of that runner-internal validator (it isn't exported across the package boundary; see COMPATIBILITY.md's contract for `@redwood-labs/cambium-runner`'s public surface).

What promote validates, fail-closed, before any downstream use:

- **`entry.class` and `entry.method`** must match `/^[A-Za-z][A-Za-z0-9_]*$/` — the same identifier family `cambium new`'s scaffolders guard names with. Both are read out of `ir.json` and reach a filesystem path (`entry.class`, via `snakeCase`, in every target filename) or a child-process argv (`entry.method`, in the `--mock` mint spawn).
- **`entry.source`** must be a string ending in `.cmb.rb`, and must resolve — after `resolve()` + `realpath` — inside the detected workspace root (a `relative()` containment check, the same shape `correctors/app-loader.ts` uses for a symlinked corrector). This field names the file promote's mint spawn passes to `cambium run`, which compiles and `load`s it as Ruby — an unguarded value here is arbitrary code execution, not just a bad filename.
- **The selected context key** (auto-selected or named via `--source`) must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` before it reaches the promoted fixture's filename.

What promote does **not** validate, and remains the operator's responsibility:

- **The content of the promoted context value.** Whatever the run's context held is written to the fixture verbatim — no scanning, no redaction. If the run captured sensitive data, promoting it commits that data to the fixture file (see "Not a redaction or editing tool" below).
- **Whether the named gen file is the one you think it is.** A validated `entry.source` is merely *contained within the workspace* — it can still point at any `.cmb.rb` file inside it, including one that doesn't match the run's `entry.class`. Promote does not re-verify the file's contents against the run that produced it (compiling it and checking is `mintSnapshot`'s job, which happens next and fails loudly on a mismatch).
- **What the mint spawn's compiled gen does.** Promote runs `cambium run <entry.source> --mock`, which executes that gen's Ruby exactly as `cambium run` always would. A workspace-contained `.cmb.rb` file is trusted at the same level as any other file in your workspace — promote adds no additional sandboxing beyond the containment check above.

## Trace

None. `cambium promote` reads a prior run's artifacts and the workspace filesystem; the fresh `--mock` mint it spawns is a completely ordinary `cambium run` invocation and writes its own `runs/<id>/` exactly as any other run would. Promote adds no IR field, no trace step, no new declaration — it's tooling, not a DSL primitive.

## Examples

```bash
# A real run just failed in a way you fixed by hand — armor it:
cambium promote run_20260910_143902_ab12cd

# Ambiguous context (a grounded gen with both a document and a page number):
cambium promote run_20260910_143902_ab12cd --source document

# Re-promote after editing the gen, refreshing the snapshot:
cambium promote run_20260910_143902_ab12cd --force

# Path form, same as replay:
cambium promote runs/run_20260910_143902_ab12cd
```

Every invocation prints exactly what it wrote (or left alone, and why) and the `npx vitest run <test>` command to confirm green.

## Failure modes

| Condition | Exit | Behavior |
| --- | --- | --- |
| Malformed bare run id (doesn't match the id shape) | 2 | Hard error quoting the expected shape; never joined onto a path. |
| Run directory not found (bare id under `<cwd>/runs/`, or the path form) | 2 | Hard error naming the path(s) tried. |
| Run directory has no `ir.json` | 2 | Hard error — not a run directory. |
| `ir.json` is a Pipeline artifact | 2 | Hard error citing the gens-first non-goal. |
| Zero or multiple eligible context keys, no `--source` | 2 | Hard error listing the keys present; use `--source <key>`. |
| `--source <key>` names a key absent from context | 2 | Hard error listing the keys that ARE present. |
| The selected context key doesn't look like a safe identifier | 2 | Hard error — refuses to use it in a filename (guards `--source`'s free-form input the same way every other symbol-into-path site is guarded). |
| `entry.class` / `entry.method` in the run's `ir.json` don't look like safe identifiers | 2 | Hard error naming the trust boundary — the run directory is untrusted input (see Trust boundary below). |
| `entry.source` isn't a string ending in `.cmb.rb`, or resolves outside the detected workspace | 2 | Hard error naming the trust boundary — refused before it ever reaches a spawn. |
| No Cambium app workspace detected (or engine mode) | 2 | Hard error naming what's missing / that engine mode isn't supported. |
| The run's `entry.source` doesn't exist relative to the detected workspace | 2 | Hard error — the artifact may have been compiled elsewhere. |
| Fixture or snapshot already exists, no `--force` | 2 | Hard error listing every colliding path; nothing written. |
| The `--mock` mint spawn exits non-zero | 1 | Hard error with the child's stderr — the fixture was already written (said explicitly), but no snapshot or test wiring happened. |
| Run directory has no `output.json` (a failed run) | 0 (not a failure) | A note is printed; promotion proceeds — this is an explicit supported case, not a degraded path. |

## What this is not

- **Not a redaction or editing tool.** Whatever the run's context held is what gets promoted verbatim; scrubbing sensitive content before commit is the operator's job.
- **Not a pipeline primitive.** Pipeline-run promotion is a deliberate non-goal today (see Semantics above).
- **Not a replacement for `cambium replay`.** Replay re-runs a prior run's post-Generate tail without re-paying for Generate; promote turns a run into a *new*, independent regression artifact. The two compose: `cambium replay <id> --mock` is a good way to iterate on a corrector before deciding a run is worth promoting.

## Related

- [[P - cambium replay]] — the sibling CLI verb this one's argument shape mirrors; also the tool to reach for before promoting, to iterate cheaply on the deterministic tail.
- [[P - Golden Tests (RED-140)]] — the fixture/snapshot/test convention promote writes into; see its "Promoting a run" section for the one-command alternative to the doc's manual first-run walkthrough.
- [[C - Trace (observability)]] — the `runs/<id>/` artifact layout promote reads (`ir.json`'s `context`; `output.json`'s optionality).
