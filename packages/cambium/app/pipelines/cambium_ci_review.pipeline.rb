# Cambium CI Review — Cambium reviewing Cambium.
#
# A real, runnable two-stage pipeline that reviews PRs against this
# very repo. Stage 1 classifies the diff into Cambium-flavored
# subsystem labels + risk categories; Stage 2 reasons from the
# structured analysis to produce a typed review with prioritized
# concerns and a verdict.
#
# Replaces the Phase H "fake reviewers" approach — this is the actual
# canonical example. The agents (CambiumDiffAnalyzer + CambiumPrReviewer)
# ship alongside; the contracts (CambiumDiffAnalysis + CambiumCiReview)
# live in src/contracts.ts.
#
# Usage:
#   cambium run packages/cambium/app/pipelines/cambium_ci_review.pipeline.rb \
#     --method review --arg <path-to-json-file> [--mock]
#
#   The pipeline is MULTI-SLOT (`diff` + `surfaces`, #233), so --arg must
#   be a JSON object supplying both: {"diff": "<unified diff text>",
#   "surfaces": ["docs", "ruby_dsl", ...]}. `scripts/ci-review-input.mjs`
#   builds this object from a diff file + a changed-file list; see
#   `.forgejo/workflows/ci-review.yml`'s "Compute PR diff + touched
#   surfaces" step. A single-slot `--arg <raw-diff-text>` invocation
#   (pre-#233) no longer works — #226 refuses a multi-slot pipeline that
#   doesn't supply every declared slot.

class CambiumCiReview < Pipeline
  input :diff, schema: PullRequestDiff

  # #233: deterministic touched-surface floor, computed by the workflow
  # from the PR's changed-file paths (`classifyTouchedSurfaces` in
  # `src/contracts.ts`) and threaded to Stage 2 alongside Stage 1's own
  # classification. Stage 1's `touched_surfaces` may ADD surfaces this
  # list can't reveal (`trace`, most obviously) but this list is never
  # subtracted from — see `app/systems/cambium_pr_reviewer.system.md`.
  input :surfaces, schema: CambiumTouchedSurfaces

  # Two-stage chain. Cheap by Cambium standards — most PRs land well
  # under the cap.
  budget tokens: 100_000

  # Stage 1: classify the diff into structured analysis. The analyzer
  # sees the raw diff text.
  step :analyze, gen: CambiumDiffAnalyzer, method: :analyze,
    with: { diff: bind(:input).diff }

  # Stage 2: reason from the structured analysis plus the deterministic
  # surface floor. The reviewer doesn't re-read the diff — Stage 1's
  # key_excerpts give it concrete snippets to anchor concerns on. This is
  # the design rationale for keeping the chain sequential vs fan-out:
  # stage 1 distills, stage 2 reasons.
  step :review, gen: CambiumPrReviewer, method: :review,
    with: { analysis: bind(:analyze), surfaces: bind(:input).surfaces }

  def review(diff)
    # Empty body per the 1:1 stance (RED-374). The operator chain
    # above is what runs; this method exists only to name the entry
    # point and type the input parameter.
  end
end
