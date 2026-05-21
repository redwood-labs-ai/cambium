/**
 * RED-381 Phase A: Pipeline DSL → IR roundtrip tests.
 *
 * Compiles a real .pipeline.rb fixture through `ruby compile.rb` and
 * asserts on the emitted IR shape per the design note in
 * docs/GenDSL Docs/N - Orchestration Layer.md § "IR shape".
 *
 * Phase A.1 (this file's initial scope): happy-path roundtrip on a
 * sequential pipeline. Phase A.2 adds fan_out + branch_on coverage.
 * Phase A.3 adds compile-error cases (bind typos, branch_on
 * exhaustiveness, 1:1 multi-method violation).
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.cwd()
const SAMPLE_FIXTURE = 'packages/cambium/app/pipelines/sample_pipeline.pipeline.rb'

function compileSample(method: string = 'review'): { ir: any | null; stderr: string } {
  try {
    const stdout = execSync(
      `ruby ${REPO_ROOT}/ruby/cambium/compile.rb ${SAMPLE_FIXTURE} --method ${method}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    return { ir: JSON.parse(stdout), stderr: '' }
  } catch (e: any) {
    return { ir: null, stderr: String(e.stderr ?? '') + String(e.message ?? '') }
  }
}

/**
 * Helper for synthesizing arbitrary pipeline bodies in a temp workspace
 * with a minimal contracts.ts containing AnalysisReport. Tests use this
 * to drive error-path scenarios (multiple methods, bad memory args, etc.)
 * without needing fixtures committed to the repo.
 */
function compilePipeline(
  body: string,
  opts: { method?: string; contractsBody?: string } = {},
): { ir: any | null; stderr: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'cambium-red381-'))
  mkdirSync(join(workspace, 'app', 'pipelines'), { recursive: true })
  mkdirSync(join(workspace, 'src'), { recursive: true })

  const contractsBody =
    opts.contractsBody ??
    `import { Type } from '@sinclair/typebox'
export const AnalysisReport = Type.Object({ summary: Type.String() }, { $id: 'AnalysisReport' })
`
  writeFileSync(join(workspace, 'src', 'contracts.ts'), contractsBody)

  const pipePath = join(workspace, 'app', 'pipelines', 'p.pipeline.rb')
  writeFileSync(pipePath, body.trim())

  const method = opts.method ?? 'run'
  try {
    const stdout = execSync(
      `ruby ${REPO_ROOT}/ruby/cambium/compile.rb ${pipePath} --method ${method}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    return { ir: JSON.parse(stdout), stderr: '' }
  } catch (e: any) {
    return { ir: null, stderr: String(e.stderr ?? '') + String(e.message ?? '') }
  }
}

describe('RED-381 Phase A: Pipeline IR — sequential happy path', () => {
  it('emits kind:"Pipeline" at top level (not a gen IR)', () => {
    const { ir, stderr } = compileSample()
    expect(stderr).toBe('')
    expect(ir).toBeTruthy()
    expect(ir.kind).toBe('Pipeline')
    expect(ir.version).toBe('0.2')
  })

  it('entry block names the class + method + source', () => {
    const { ir } = compileSample()
    expect(ir.entry).toEqual({
      class: 'SamplePipeline',
      method: 'review',
      source: SAMPLE_FIXTURE,
    })
  })

  it('input block carries typed input slots', () => {
    const { ir } = compileSample()
    expect(ir.input).toEqual({
      document: { schema: 'AnalysisReport' },
    })
  })

  it('policies.budget carries the top-level cap', () => {
    const { ir } = compileSample()
    expect(ir.policies.budget).toEqual({ tokens: 50_000, tool_calls: 50 })
  })

  it('policies.bind_defaults is :explicit by default', () => {
    const { ir } = compileSample()
    expect(ir.policies.bind_defaults).toBe('explicit')
  })

  it('policies.memory carries pipeline-level shared slots (default scope :pipeline_run)', () => {
    const { ir } = compileSample()
    expect(ir.policies.memory).toEqual([
      { name: 'findings', scope: 'pipeline_run', strategy: 'log' },
    ])
  })

  it('operators array preserves declaration order', () => {
    const { ir } = compileSample()
    expect(ir.operators.map((o: any) => o.id)).toEqual(['triage', 'remediate', 'summary'])
    expect(ir.operators.every((o: any) => o.kind === 'Step')).toBe(true)
  })

  it('step `with: { ctx: bind(:input).field }` encodes as { input: "field" }', () => {
    const { ir } = compileSample()
    const triage = ir.operators[0]
    expect(triage.with).toEqual([
      { param: 'document', from: { input: 'document' } },
    ])
  })

  it('step `with: { ctx: bind(:step).field }` encodes as { step, field }', () => {
    const { ir } = compileSample()
    const remediate = ir.operators[1]
    expect(remediate.with).toEqual([
      { param: 'document', from: { step: 'triage', field: 'summary' } },
    ])
  })

  it('step without `with:` omits the with key (no empty array)', () => {
    const { ir } = compileSample()
    const summary = ir.operators[2]
    expect(summary.with).toBeUndefined()
  })

  it('default output is { kind: "last_step" } when no output block declared', () => {
    const { ir } = compileSample()
    expect(ir.output).toEqual({ kind: 'last_step' })
  })

  it('emits {method → ir} map when --method is omitted (cambium serve boot shape)', () => {
    try {
      const stdout = execSync(
        `ruby ${REPO_ROOT}/ruby/cambium/compile.rb ${SAMPLE_FIXTURE}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const irs = JSON.parse(stdout)
      expect(Object.keys(irs)).toEqual(['review'])
      expect(irs.review.kind).toBe('Pipeline')
    } catch (e: any) {
      throw new Error(`compile failed: ${e.stderr ?? e.message}`)
    }
  })
})

describe('RED-381 Phase A: Pipeline structural rules', () => {
  it('rejects pipelines with multiple public methods (1:1 stance)', () => {
    const body = `
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
  def run_quick(doc); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/declares multiple public methods/)
    expect(stderr).toMatch(/1:1/)
  })

  it('rejects pipeline class with no public methods', () => {
    const body = `
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/No public methods found/)
  })

  it('rejects unknown input schema with available-schemas listing', () => {
    const body = `
class P < Pipeline
  input :doc, schema: NoSuchSchema
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/Unknown schema 'NoSuchSchema' on input :doc/)
    expect(stderr).toMatch(/Available schemas/)
    expect(stderr).toMatch(/AnalysisReport/)
  })

  it('rejects duplicate input declarations', () => {
    const body = `
class P < Pipeline
  input :doc, schema: AnalysisReport
  input :doc, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/duplicate input :doc/)
  })

  it('rejects bind_defaults values outside the valid set', () => {
    const body = `
class P < Pipeline
  input :doc, schema: AnalysisReport
  bind_defaults :magic
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/bind_defaults must be one of :explicit, :pass_through/)
  })

  it('rejects budget keys outside { tokens, tool_calls }', () => {
    const body = `
class P < Pipeline
  input :doc, schema: AnalysisReport
  budget per_run: { max_calls: 5 }
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/budget: unknown keys per_run/)
  })

  it('rejects non-positive budget values', () => {
    const body = `
class P < Pipeline
  input :doc, schema: AnalysisReport
  budget tokens: 0
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/budget tokens: must be a positive Integer/)
  })
})

describe('RED-381 Phase A: fan_out operator IR', () => {
  it('emits FanOut entry with branches, threshold, concurrency, on_branch_failure', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :recon, gen: Analyst, method: :analyze
  fan_out :reviewers, collect_into: :reviews do
    branch :security, agent: Analyst, method: :analyze
    branch :perf,     agent: Analyst, method: :analyze
    concurrency 2
    on_branch_failure :continue
    require :at_least, 1
    pass_context :surface_map
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(stderr).toBe('')
    const fan = ir.operators[1]
    expect(fan.kind).toBe('FanOut')
    expect(fan.id).toBe('reviewers')
    expect(fan.collect_into).toBe('reviews')
    expect(fan.concurrency).toBe(2)
    expect(fan.on_branch_failure).toBe('continue')
    expect(fan.require).toEqual({ kind: 'at_least', n: 1 })
    expect(fan.pass_context).toEqual(['surface_map'])
    expect(fan.branches).toEqual([
      { id: 'security', agent: 'Analyst', method: 'analyze' },
      { id: 'perf',     agent: 'Analyst', method: 'analyze' },
    ])
  })

  it('defaults: on_branch_failure="continue", require={kind:"all"}, no concurrency, no pass_context', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  fan_out :reviewers, collect_into: :reviews do
    branch :a, agent: Analyst, method: :analyze
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(stderr).toBe('')
    const fan = ir.operators[0]
    expect(fan.on_branch_failure).toBe('continue')
    expect(fan.require).toEqual({ kind: 'all' })
    expect(fan.concurrency).toBeUndefined()
    expect(fan.pass_context).toBeUndefined()
  })

  it('captures homogeneous-fan-out sugar (agent + over + as)', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  fan_out :reviews, collect_into: :results do
    agent Analyst, method: :analyze
    over [:legal, :financial, :technical], as: :aspect
    concurrency 3
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(stderr).toBe('')
    const fan = ir.operators[0]
    expect(fan._homogeneous).toEqual({
      agent: 'Analyst',
      method: 'analyze',
      over: ['legal', 'financial', 'technical'],
      as: 'aspect',
    })
  })

  it('rejects bad on_branch_failure', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  fan_out :reviewers, collect_into: :reviews do
    branch :a, agent: Analyst, method: :analyze
    on_branch_failure :explode
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/on_branch_failure: must be :continue or :fail_fast/)
  })
})

describe('RED-381 Phase A: branch_on operator IR', () => {
  it('emits BranchOn entry with signal, branches[], and default', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).severity do
    on :critical do
      step :page, gen: Analyst, method: :analyze
      step :remediate, gen: Analyst, method: :analyze
    end
    on :high do
      step :remediate, gen: Analyst, method: :analyze
    end
    default do
    end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(stderr).toBe('')
    const br = ir.operators[1]
    expect(br.kind).toBe('BranchOn')
    expect(br.signal).toEqual({ step: 'triage', field: 'severity' })
    expect(br.branches).toEqual([
      {
        values: ['critical'],
        operators: [
          { kind: 'Step', id: 'page',      gen: 'Analyst', method: 'analyze' },
          { kind: 'Step', id: 'remediate', gen: 'Analyst', method: 'analyze' },
        ],
      },
      {
        values: ['high'],
        operators: [
          { kind: 'Step', id: 'remediate', gen: 'Analyst', method: 'analyze' },
        ],
      },
    ])
    expect(br.default).toEqual([])
  })

  it('allows multiple values per on clause', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).severity do
    on :low, :info do
    end
    default do
    end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(stderr).toBe('')
    expect(ir.operators[1].branches[0].values).toEqual(['low', 'info'])
  })

  it('rejects branch_on with a non-bind signal', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  branch_on :severity do
    on :critical do; end
    default do; end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/branch_on: signal must be a bind\(\.\.\.\) reference/)
  })
})

describe('RED-381 Phase A: output composition block', () => {
  it('captures explicit output fields as { name, from } entries', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :triage,    gen: Analyst, method: :analyze
  step :remediate, gen: Analyst, method: :analyze
  output do
    severity bind(:triage).severity
    plan     bind(:remediate).plan
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(stderr).toBe('')
    expect(ir.output).toEqual({
      kind: 'compose',
      fields: [
        { name: 'severity', from: { step: 'triage',    field: 'severity' } },
        { name: 'plan',     from: { step: 'remediate', field: 'plan' } },
      ],
    })
  })

  it('rejects an output field whose value is not a bind(...) reference', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  output do
    severity "hardcoded"
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/output field 'severity': must be a bind\(\.\.\.\) reference/)
  })

  it('rejects duplicate output field names', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :a, gen: Analyst, method: :analyze
  output do
    severity bind(:a).severity
    severity bind(:a).other
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/output field 'severity' declared more than once/)
  })
})

// ───────────────────────────────────────────────────────────────────
// Phase A.3 — strict bind() cross-validation, branch_on exhaustiveness,
// pipeline-file basename regex, and the canonical CI Review fixture
// rounding out Phase A acceptance.
// ───────────────────────────────────────────────────────────────────

describe('RED-381 Phase A.3: bind() cross-validation', () => {
  it('rejects bind(:input).<unknown> in a step with: clause', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze,
    with: { ctx: bind(:input).not_a_real_slot }
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/unknown input slot bind\(:input\)\.not_a_real_slot/)
    expect(stderr).toMatch(/Declared inputs: :pr/)
  })

  it('rejects bind(:step) where step is undeclared', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze,
    with: { ctx: bind(:ghost).summary }
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/bind\(:ghost\)\.summary/)
    expect(stderr).toMatch(/not declared before this operator/)
  })

  it('rejects forward bind() refs (step declared AFTER the referencing operator)', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze,
    with: { ctx: bind(:s2).summary }
  step :s2, gen: Analyst, method: :analyze
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/operator :s1 .* references bind\(:s2\)\.summary/)
    expect(stderr).toMatch(/not declared before this operator/)
    expect(stderr).toMatch(/Declared earlier: \(none\)/)
  })

  it('accepts forward output composition refs (output is logically last)', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  output do
    summary bind(:s1).summary
    answer  bind(:s2).answer
  end
  step :s2, gen: Analyst, method: :analyze
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(stderr).toBe('')
    expect(ir.output.kind).toBe('compose')
    expect(ir.output.fields.map((f: any) => f.name)).toEqual(['summary', 'answer'])
  })

  it('rejects output field referencing unknown input slot', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  output do
    bogus bind(:input).not_there
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/output field :bogus/)
    expect(stderr).toMatch(/unknown input slot bind\(:input\)\.not_there/)
  })

  it('rejects output field referencing unknown step', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  output do
    answer bind(:ghost).field
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/output field :answer/)
    expect(stderr).toMatch(/references step :ghost/)
  })

  it('validates bind() refs inside nested operators (branch_on `on` body)', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).severity do
    on :critical do
      step :remediate, gen: Analyst, method: :analyze,
        with: { ctx: bind(:nope).field }
    end
    default do; end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/operator :remediate/)
    expect(stderr).toMatch(/bind\(:nope\)\.field/)
  })

  it('validates bind() refs inside default block too', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).severity do
    on :critical do; end
    default do
      step :fallback, gen: Analyst, method: :analyze,
        with: { ctx: bind(:input).missing }
    end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/operator :fallback/)
    expect(stderr).toMatch(/unknown input slot bind\(:input\)\.missing/)
  })
})

describe('RED-381 Phase A.3: branch_on exhaustiveness', () => {
  it('rejects branch_on without a `default` block', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).severity do
    on :critical do; end
    on :high do; end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/branch_on .* requires an explicit `default do \.\.\. end` block/)
  })

  it('rejects branch_on with no on clauses and no default (empty operator)', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).severity do
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/declares neither an `on` clause nor a `default` block/)
  })

  it('rejects branch_on whose signal references an undeclared step', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  branch_on bind(:ghost).severity do
    on :a do; end
    default do; end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/branch_on .* signal bind\(:ghost\)\.severity/)
    expect(stderr).toMatch(/not declared before this branch_on/)
  })

  it('rejects branch_on whose signal is bind(:input).field (not yet supported)', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  branch_on bind(:input).pr do
    on :critical do; end
    default do; end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/branch_on .* must use a bind\(:step_id\)\.field signal/)
  })

  it('accepts branch_on with both on clauses AND an explicit default', () => {
    const body = `
class P < Pipeline
  input :pr, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).severity do
    on :critical do; end
    on :high do; end
    default do; end
  end
  def run(pr); end
end
`
    const { ir, stderr } = compilePipeline(body)
    expect(stderr).toBe('')
    expect(ir.operators[1].kind).toBe('BranchOn')
    expect(ir.operators[1].default).toEqual([])
  })
})

describe('RED-381 Phase A.3: pipeline file basename regex', () => {
  function compileWithBasename(basename: string): { ir: any | null; stderr: string } {
    const workspace = mkdtempSync(join(tmpdir(), 'cambium-red381-basename-'))
    mkdirSync(join(workspace, 'app', 'pipelines'), { recursive: true })
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(
      join(workspace, 'src', 'contracts.ts'),
      `import { Type } from '@sinclair/typebox'
export const AnalysisReport = Type.Object({ summary: Type.String() }, { $id: 'AnalysisReport' })
`,
    )
    const pipePath = join(workspace, 'app', 'pipelines', `${basename}.pipeline.rb`)
    writeFileSync(
      pipePath,
      `class P < Pipeline
  input :pr, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  def run(pr); end
end
`,
    )
    try {
      const stdout = execSync(
        `ruby ${REPO_ROOT}/ruby/cambium/compile.rb ${pipePath} --method run`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      )
      return { ir: JSON.parse(stdout), stderr: '' }
    } catch (e: any) {
      return { ir: null, stderr: String(e.stderr ?? '') + String(e.message ?? '') }
    }
  }

  it('accepts a snake_case basename', () => {
    const { ir, stderr } = compileWithBasename('ci_review')
    expect(stderr).toBe('')
    expect(ir.kind).toBe('Pipeline')
  })

  it('accepts a single-word lowercase basename', () => {
    const { ir, stderr } = compileWithBasename('triage')
    expect(stderr).toBe('')
    expect(ir.kind).toBe('Pipeline')
  })

  it('rejects a CamelCase basename', () => {
    const { ir, stderr } = compileWithBasename('CiReview')
    expect(ir).toBeNull()
    expect(stderr).toMatch(/Pipeline file basename 'CiReview' must match/)
  })

  it('rejects a basename starting with a digit', () => {
    const { ir, stderr } = compileWithBasename('2cool')
    expect(ir).toBeNull()
    expect(stderr).toMatch(/must match/)
  })

  it('rejects a basename with a hyphen', () => {
    const { ir, stderr } = compileWithBasename('ci-review')
    expect(ir).toBeNull()
    expect(stderr).toMatch(/must match/)
  })
})

describe('RED-381 Phase A.3: canonical CI Review fixture', () => {
  function compileCiReview(): { ir: any | null; stderr: string } {
    try {
      const stdout = execSync(
        `ruby ${REPO_ROOT}/ruby/cambium/compile.rb packages/cambium/app/pipelines/ci_review.pipeline.rb --method review`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      )
      return { ir: JSON.parse(stdout), stderr: '' }
    } catch (e: any) {
      return { ir: null, stderr: String(e.stderr ?? '') + String(e.message ?? '') }
    }
  }

  it('compiles cleanly to a Pipeline IR', () => {
    const { ir, stderr } = compileCiReview()
    expect(stderr).toBe('')
    expect(ir.kind).toBe('Pipeline')
    expect(ir.entry.method).toBe('review')
    expect(ir.name).toBe('CiReview')
  })

  it('declares the :pr input slot with schema AnalysisReport', () => {
    const { ir } = compileCiReview()
    expect(ir.input).toEqual({ pr: { schema: 'AnalysisReport' } })
  })

  it('carries the top-level budget cap (tokens + tool_calls)', () => {
    const { ir } = compileCiReview()
    expect(ir.policies.budget).toEqual({ tokens: 200_000, tool_calls: 200 })
  })

  it('declares the pipeline-shared :findings memory slot', () => {
    const { ir } = compileCiReview()
    expect(ir.policies.memory).toEqual([
      { name: 'findings', scope: 'pipeline_run', strategy: 'log' },
    ])
  })

  it('emits 3 operators in order: recon (Step) → reviewers (FanOut) → fix (Step)', () => {
    const { ir } = compileCiReview()
    expect(ir.operators.map((o: any) => `${o.kind}:${o.id}`)).toEqual([
      'Step:recon',
      'FanOut:reviewers',
      'Step:fix',
    ])
  })

  it('fan_out carries all four reviewer branches with correct shape', () => {
    const { ir } = compileCiReview()
    const fanOut = ir.operators[1]
    expect(fanOut.kind).toBe('FanOut')
    expect(fanOut.collect_into).toBe('reviews')
    expect(fanOut.concurrency).toBe(4)
    expect(fanOut.on_branch_failure).toBe('continue')
    expect(fanOut.require).toEqual({ kind: 'all' })
    expect(fanOut.pass_context).toEqual(['surface_map'])
    expect(fanOut.branches.map((b: any) => b.id)).toEqual([
      'security',
      'architectural',
      'performance',
      'semantic',
    ])
    expect(fanOut.branches.every((b: any) => b.method === 'review')).toBe(true)
  })

  it("Fixer step binds to both bind(:input).pr AND bind(:reviewers) typed array", () => {
    const { ir } = compileCiReview()
    const fix = ir.operators[2]
    expect(fix.id).toBe('fix')
    expect(fix.with).toEqual([
      { param: 'pr',      from: { input: 'pr' } },
      { param: 'reviews', from: { step: 'reviewers' } },
    ])
  })
})

describe('RED-381 Phase A: pipeline does not perturb the gen-IR path', () => {
  it('a gen file still compiles to a gen IR (kind absent, version 0.2)', () => {
    // Sanity: the dispatch in compile.rb routes pipeline files to
    // PipelineCompiler but gens still flow through the existing path
    // untouched. Use an existing in-tree gen and verify it doesn't
    // suddenly emit kind:"Pipeline".
    try {
      const stdout = execSync(
        `ruby ${REPO_ROOT}/ruby/cambium/compile.rb packages/cambium/app/gens/analyst.cmb.rb --method analyze`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const ir = JSON.parse(stdout)
      expect(ir.version).toBe('0.2')
      expect(ir.kind).toBeUndefined() // gen IRs don't carry a kind field
      expect(ir.entry?.class).toBe('Analyst')
      expect(ir.steps).toBeDefined() // gens have steps; pipelines have operators
    } catch (e: any) {
      throw new Error(`gen compile failed: ${e.stderr ?? e.message}`)
    }
  })
})
