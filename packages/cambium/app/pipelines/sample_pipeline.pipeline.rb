# Phase A smoke fixture (RED-381). Minimal Pipeline declaration that
# exercises every non-operator declaration plus the `step` operator —
# enough to drive Phase A.1's IR-roundtrip test. Fan_out / branch_on /
# output composition lives in fixtures that load alongside Phase A.2.

class SamplePipeline < Pipeline
  input :document, schema: AnalysisReport

  bind_defaults :explicit

  budget tokens: 50_000, tool_calls: 50

  memory :findings, strategy: :log

  step :triage,    gen: Analyst, method: :analyze,
    with: { document: bind(:input).document }

  step :remediate, gen: Analyst, method: :analyze,
    with: { document: bind(:triage).summary }

  step :summary,   gen: Analyst, method: :analyze

  def review(document)
    # Empty body — entry-point declaration only. The 1:1 stance means
    # this method exists to (a) name the entry point and (b) type the
    # input parameter; the operator chain above is what actually runs.
  end
end
