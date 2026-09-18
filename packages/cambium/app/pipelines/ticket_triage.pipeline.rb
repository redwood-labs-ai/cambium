# #275: proves a pipeline can read a decision gen's recorded confidence —
# a value lookup (bind), not orchestration-layer inference. See
# PLAN-275-decision-mode-2026-09-17.md "Reading it from a pipeline".

class TicketTriage < Pipeline
  input :ticket, schema: AnalysisReport         # name-existence check only; mirrors sample_pipeline

  step :route, gen: TicketRouter, method: :route, with: { document: bind(:input).ticket }

  output do
    department bind(:route).department
    confidence bind(:route)._decision.department.confidence
  end

  def triage(ticket); end
end
