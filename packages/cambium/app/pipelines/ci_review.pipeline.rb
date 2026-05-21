# Canonical CI Review pipeline — the forcing-case example from the
# RED-374 design note and the Phase A acceptance fixture for RED-381.
#
# Shape:    recon → 4 reviewer fan-out → Fixer
# Tests:    IR-roundtrip + bind validation + branch_on exhaustiveness
#
# NOTE: The referenced agent classes (SurfaceMapper, SecurityReviewer,
# ArchitecturalReviewer, PerformanceReviewer, SemanticReviewer, Fixer)
# don't ship in this commit — Phase A only proves the IR shape. The
# end-to-end Phase H pass adds the real gen files alongside the runtime
# wiring. Compile-time validation of `gen:` references against the
# class registry is deliberately deferred to runtime (the runner catches
# missing classes when it tries to load the sub-gen IR), so this fixture
# compiles cleanly without those classes existing yet.

class CiReview < Pipeline
  input :pr, schema: AnalysisReport

  budget tokens: 200_000
  budget tool_calls: 200

  # Intra-run shared scratchpad. The Fixer reads this bucket at its step
  # start (after all four reviewers have written); reviewers don't see
  # each other mid-fan-out (read-at-start / write-at-success lifecycle
  # falls out of RED-215). See N - Orchestration Layer § Pipeline memory.
  memory :findings, strategy: :log

  step :recon, gen: SurfaceMapper, method: :map,
    with: { ctx: bind(:input).pr }

  fan_out :reviewers, collect_into: :reviews do
    branch :security,      agent: SecurityReviewer,      method: :review
    branch :architectural, agent: ArchitecturalReviewer, method: :review
    branch :performance,   agent: PerformanceReviewer,   method: :review
    branch :semantic,      agent: SemanticReviewer,      method: :review

    concurrency 4
    on_branch_failure :continue
    require :all
    pass_context :surface_map
  end

  step :fix, gen: Fixer, method: :patch,
    with: {
      pr:      bind(:input).pr,
      reviews: bind(:reviewers)
    }

  def review(pr)
    # Empty body — entry-point declaration only (1:1 stance per RED-374).
  end
end
