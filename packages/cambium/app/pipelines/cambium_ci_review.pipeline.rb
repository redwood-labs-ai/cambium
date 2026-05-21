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
#     --method review --arg <path-to-diff-text> [--mock]

class CambiumCiReview < Pipeline
  input :diff, schema: PullRequestDiff

  # Two-stage chain. Cheap by Cambium standards — most PRs land well
  # under the cap.
  budget tokens: 100_000

  # Stage 1: classify the diff into structured analysis. The analyzer
  # sees the raw diff text.
  step :analyze, gen: CambiumDiffAnalyzer, method: :analyze,
    with: { diff: bind(:input).diff }

  # Stage 2: reason from the structured analysis. The reviewer doesn't
  # re-read the diff — Stage 1's key_excerpts give it concrete snippets
  # to anchor concerns on. This is the design rationale for keeping
  # the chain sequential vs fan-out: stage 1 distills, stage 2 reasons.
  step :review, gen: CambiumPrReviewer, method: :review,
    with: { analysis: bind(:analyze) }

  def review(diff)
    # Empty body per the 1:1 stance (RED-374). The operator chain
    # above is what runs; this method exists only to name the entry
    # point and type the input parameter.
  end
end
