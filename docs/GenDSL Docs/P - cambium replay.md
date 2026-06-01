# Primitive: cambium replay

**Doc ID:** gen-dsl/primitive/cambium-replay

## Purpose

Re-execute a prior run's **post-Generate tail** — validate → repair → correct → grounding → signals — against its candidate output, *without re-paying for the expensive Generate (and tool) calls that already ran*.

The architectural property in play has existed since the trace stabilized: **the trace IS the canonical execution savepoint.** `runs/<id>/` carries `ir.json` (what ran), `output.json` (the candidate), and `trace.json` (where it diverged) — together they're complete enough to resume. The cost profile is what makes this load-bearing:

- Generate + tool calls are the **expensive** steps (tokens, latency).
- Validate + correct + repair + grounding are the **cheap, deterministic** steps that **need iteration**.
- A normal run makes you re-pay the expensive step every time you want to iterate on the cheap tail. Replay keeps the expensive step paid-for.

Enabling invariant: RED-298's `CorrectAcceptedWithErrors` graceful-degrade semantics make the post-run artifact triage-able (a refused-but-recoverable state) rather than crash-shaped. Replay reads that artifact.

## Surface

```bash
# Gen runs:
cambium replay <run-id>                       # resume from output.json (default checkpoint)
cambium replay <run-id> --edit                # open $EDITOR on the candidate first
cambium replay <run-id> --from-step <type>    # resume from a trace step type's recorded output

# Pipeline runs:
cambium replay <run-id>                       # resume from the first incomplete operator
cambium replay <run-id> --from-op <id>        # resume from a specific operator

# Common:
cambium replay runs/run_2026...               # path form also accepted
cambium replay <run-id> --mock                # run any downstream repair / re-run in mock mode
```

`cambium replay` routes by the prior run's IR `kind` (gen vs Pipeline), the
same way `cambium run` does. `--from-step` is gen-level; `--from-op` is
pipeline-level; passing the wrong one for the run kind is a clear error.

Library equivalents (the CLI is sugar over these):

```ts
runGenFromIr({ ir, candidate, fromStep, parentRunId })                  // gen
runPipelineFromIr({ ir, replay: { priorTrace, parentRunId, fromOp } })  // pipeline
```

## Semantics (normative)

- **Generate is skipped.** On replay, `runGen` seeds the post-Generate candidate from the resolved value and emits a `ReplayResume` trace step *in place of* `Generate`. For agentic gens the entire tool-use loop is skipped uniformly (the resume branch sits before the mode check). Enrichments are skipped too — they feed the Generate prompt and fire their own sub-agent calls.
- **No model/tool call fires** during replay *unless* a downstream step genuinely needs one — i.e. the candidate fails validation/correction and a `Repair` is triggered. That is the one place replay can re-pay, and only on a genuinely-failing candidate.
- **Checkpoint resolution.** Default = `output.json` (the complete post-Generate artifact). `--from-step <type>` = the **last** trace step of that type that recorded an `output` value (last-instance-wins handles repair loops). Steps that record no output (e.g. `Generate`, which stores only a truncated preview) are rejected with a clear pointer to use the default.
- **Lineage.** The replay writes a fresh `runs/<new-id>/` whose `trace.parent_run_id` references the source run. Chains compose: `run_A → run_B(parent=A) → run_C(parent=B)`.
- **`--edit`** opens `$EDITOR` (`$VISUAL`, else `vi`) on the candidate, git-commit-style: empty file on save → abort; malformed JSON → re-prompt with the parse error (capped at 5 attempts). Gen-level only.

### Pipeline resume (RED-385 Phase B)

- **Resume point.** Default: the first operator whose prior-trace entry is missing or not `ok: true` (covers `ok:false`, budget-exceeded, and error entries). `--from-op <id>` overrides it. Matching is by index — `priorTrace.operators[i] ↔ ir.operators[i]` — exact because replay reuses the same IR.
- **Rehydration.** `stepResults` (the `bind()`-resolution state) is rebuilt from the recorded `output` of each operator *before* the resume point (RED-385 Phase A persisted these). `branch_on` bodies are walked recursively so nested step/fan_out outputs are restored. Reused operators are pushed into the new trace tagged `reused: true`; only the resume point onward is re-dispatched.
- **`step` + `branch_on` resume fully.** A `branch_on` re-evaluates deterministically from the rehydrated signal (no LLM — it's pure routing).
- **`fan_out` is whole-operator in this release.** A successful fan_out *before* the resume point is reused wholesale (its merged output rehydrated). A fan_out *at or after* the resume point re-runs **all** its branches. Partial-branch reuse — "re-run only the one branch that failed" — is the RED-385 piece C follow-up.
- **Budget continuity.** `trace.meta.total_tokens` / `total_tool_calls` seed from the parent trace so the pipeline cap spans the whole replay chain (a resumed run can't escape the cap by zeroing prior spend).
- **Memory.** The `:pipeline_run` bucket is fresh — keyed on the new run id, since a replay is a new logical run.
- **Guard.** If `--from-op` would reuse an upstream operator that did not succeed in the prior run, replay errors (it won't feed downstream steps a failed output) — pick a resume point at or before it.
- **Refusal:** there's no resume point when the prior run completed every operator; pass `--from-op` to force one.

## Trace

- New step type `ReplayResume` (meta: `parent_run_id`, `from_step`, `mode`). See [[C - Trace (observability)]] § Step types.
- New top-level field `parent_run_id`. See [[C - Trace (observability)]] § Top-level fields.

## Examples

```bash
# Iterate on a corrector after a run flagged unhealed math:
cambium replay run_20260422_114135_abc

# Hand-fix the candidate, then re-run the deterministic tail against it:
cambium replay run_20260422_114135_abc --edit

# Resume from the output a specific corrector step produced:
cambium replay run_20260422_114135_abc --from-step Correct

# Path form; run any triggered repair in mock mode:
cambium replay runs/run_20260422_114135_abc --mock

# Pipeline: resume from the first incomplete operator (e.g. a failed fan_out):
cambium replay run_20260422_114135_abc

# Pipeline: force a resume point — reuse recon + reviewers, re-run fix:
cambium replay run_20260422_114135_abc --from-op fix
```

Each invocation writes a fresh `runs/<new-id>/` with `parent_run_id` set; chain
replays to walk an iteration history.

## Failure modes

| Condition | Behavior |
| --- | --- |
| Run directory not found (`<cwd>/runs/<id>` and path form both miss) | Hard error listing the paths tried; nothing runs. |
| `output.json` (or `ir.json`) missing in the run dir | Hard error naming the missing artifact. |
| `--from-step <type>` names a step type absent from the trace | Hard error listing the step types that ARE present; suggests omitting `--from-step`. |
| `--from-step <type>` names a step that recorded no output (e.g. `Generate`) | Hard error — resume from `output.json` (omit `--from-step`) instead. |
| `--from-step` used but `trace.json` is absent | Hard error (the checkpoint can't be resolved without the trace). |
| `--from-step` on a Pipeline run / `--from-op` on a gen run | Hard error — the flags are mode-specific (`--from-step` gen, `--from-op` pipeline). |
| Pipeline replay but `trace.json` is absent | Hard error — the operator outputs to rehydrate live in the trace. |
| `--from-op <id>` names an operator not in the pipeline | Hard error listing the pipeline's operator ids. |
| Pipeline `--from-op` would reuse an operator that didn't succeed | Hard error — pick a resume point at or before the failed operator. |
| Pipeline prior run completed every operator | "Nothing to resume" — pass `--from-op` to force a resume point. |
| `--edit` on a Pipeline run | Hard error — `--edit` is gen-level (a pipeline resume has no single candidate). |
| Seeded candidate fails validation | The normal repair loop runs — this is the one path that may spend tokens (and the only reason to pass `--mock` in tests). |
| `--edit` saves an empty file | Abort, nothing runs. |
| `--edit` saves malformed JSON | Re-prompt with the parse error (capped at 5 attempts). |

## Explicitly NOT in scope (file separately)

- **Content-addressed runs** — hash `(IR, input, model, temperature, env)` → dedupe cache.
- **Replay with perturbation** — `--set system=updated.system.md` pins everything else and swaps one field, for structured baseline comparison.
- **Remote run store** — `CAMBIUM_RUNS_PATH=s3://…`, a pluggable artifact writer.
- **Interactive triage REPL** — `--edit` is the minimum generic primitive; richer triage stays app-level.

## Related

- [[C - Trace (observability)]] — the savepoint artifact replay reads.
- [[N - Orchestration Layer]] — pipeline runs, whose operator-level replay is the follow-up.
- [[C - Serve Mode]] — both read the same `runs/<id>/` artifacts.
