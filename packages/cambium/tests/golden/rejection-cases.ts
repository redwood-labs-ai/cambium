/**
 * Rejection cases for the golden IR corpus (DEC-006 / DEC-007a).
 *
 * One representative case per DSL keyword family. Each `expectMessage`
 * is a verbatim substring of the Ruby raise site in runtime.rb /
 * compile.rb / pipeline.rb / cron.rb (grep the source to verify).
 *
 * Adding a row is a one-liner — the harness in rejection.test.ts
 * drives `it.each` over this table.
 *
 * `filename` overrides the temp-file basename when the compiler
 * validates the filename (pipeline files must end in .pipeline.rb
 * with a name matching /^[a-z][a-z0-9_]*$/).
 */

export type RejectionCase = {
  /** Short human-readable name shown in the test runner. */
  name: string
  /** Ruby DSL snippet written to a temp file and compiled. */
  dsl: string
  /** Optional temp-file basename (default: test_gen.cmb.rb). */
  filename?: string
  /** Optional --method flag value for compile.rb. */
  method?: string
  /** Expected Ruby exception class substring in stderr. */
  expectClass: string
  /** Expected error message substring in stderr (verbatim from raise site). */
  expectMessage: string
}

export const cases: RejectionCase[] = [
  // ── returns block ─────────────────────────────────────────────────────────
  {
    name: 'returns: duplicate field name',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  returns do
    field :name, String
    field :name, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: "returns: duplicate field name 'name'.",
  },
  {
    name: 'returns: empty block declares no fields',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  returns do
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: 'returns do … end block declares no fields.',
  },
  {
    name: 'returns: empty enum',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  returns do
    field :status, String, enum: []
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: "returns: field 'status' has an empty `enum:`.",
  },

  // ── security ──────────────────────────────────────────────────────────────
  {
    name: 'security: network not a Hash',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  security network: "bad"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'security network: must be a Hash',
  },
  {
    name: 'security: filesystem not a Hash',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  security filesystem: "bad"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'security filesystem: must be a Hash',
  },
  {
    name: 'security: unknown keys',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  security bogus_key: true
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'unknown security keys: bogus_key',
  },

  {
    name: 'security: exec { allowed: true } no longer defaults to native (Gate 3)',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  security exec: { allowed: true }
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: 'no longer defaults to unsandboxed native',
  },
  {
    name: 'security: exec runtime: :native is a compile error (Gate 3)',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  security exec: { runtime: :native }
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: 'runtime: :native is no longer accepted',
  },

  // ── budget ────────────────────────────────────────────────────────────────
  {
    name: 'budget: per_tool not a Hash',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  budget per_tool: "bad"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'budget per_tool: must be a Hash',
  },
  {
    name: 'budget: per_run not a Hash',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  budget per_run: "bad"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'budget per_run: must be a Hash',
  },
  {
    name: 'budget: unsupported metric',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  budget per_run: { max_time: 100 }
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'unsupported budget metric(s) for per_run: max_time',
  },
  {
    name: 'budget: per_run max_tokens must be a positive Integer',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  budget per_run: { max_tokens: -1 }
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x" do; with context: x; end
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'budget per_run max_tokens: must be a positive Integer',
  },
  {
    name: 'budget: per_run max_duration must match format',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  budget per_run: { max_duration: "5 minutes" }
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x" do; with context: x; end
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'budget per_run max_duration: must match',
  },
  {
    name: 'budget: unknown keys',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  budget max_spend: 100
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'unknown budget keys: max_spend',
  },

  // ── model / aliases ───────────────────────────────────────────────────────
  {
    name: 'model: unknown alias',
    dsl: `
class TestGen < GenModel
  model :nonexistent_alias
  system "inline"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: 'unknown model alias :nonexistent_alias',
  },

  // ── grounded_in ───────────────────────────────────────────────────────────
  {
    name: 'grounded_in: bad source (path-traversal guard)',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  grounded_in :"bad source"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'grounded_in source must match /^[a-z][a-z0-9_]*$/, got:',
  },
  {
    name: 'grounded_in: bad verify strategy',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  grounded_in :document, verify: :bad_strategy
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'grounded_in :document verify: must be nil or one of :field_values, got :bad_strategy',
  },

  // ── memory ────────────────────────────────────────────────────────────────
  {
    name: 'memory: invalid strategy',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  memory :facts, strategy: :bogus
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'memory facts: strategy must be one of :sliding_window, :semantic, :log (got :bogus)',
  },
  {
    name: 'memory: scope :session requires strategy (compile.rb guard)',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  memory :facts, scope: :session
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: "memory 'facts' scope: :session needs `strategy:`",
  },

  // ── constrain ─────────────────────────────────────────────────────────────
  {
    name: 'constrain: compound unknown kwargs',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  constrain :compound, strategy: :critique, bad_kwarg: "x"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'constrain :compound — unknown kwargs: bad_kwarg.',
  },

  // ── log ───────────────────────────────────────────────────────────────────
  {
    name: 'log: unknown option',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  log :stdout, bad_opt: true
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'ArgumentError',
    expectMessage: 'log: unknown option(s) bad_opt.',
  },

  // ── system ────────────────────────────────────────────────────────────────
  {
    name: 'system: path-traversal guard on symbol name',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system :"../etc/passwd"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: "system: '../etc/passwd' is not a valid system prompt name.",
  },

  // ── compile.rb structural ─────────────────────────────────────────────────
  {
    name: 'compile.rb: no GenModel or Pipeline subclass',
    dsl: `x = 1`,
    expectClass: 'Cambium::CompileError',
    expectMessage: 'No GenModel or Pipeline subclass found after loading',
  },
  {
    name: 'compile.rb: no public methods on GenModel',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  returns do
    field :result, String
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: 'No public methods found on TestGen in',
  },

  // ── cron.rb ───────────────────────────────────────────────────────────────
  {
    name: 'cron: unknown named vocabulary',
    dsl: `
class TestGen < GenModel
  model "omlx:some-model"
  system "inline"
  cron :yearly, at: "9:00"
  returns do
    field :result, String
  end
  def analyze(x)
    generate "x"
  end
end
`.trim(),
    expectClass: 'Cambium::CompileError',
    expectMessage: 'unknown cron name :yearly.',
  },

  // ── pipeline.rb ───────────────────────────────────────────────────────────
  {
    name: 'pipeline: no public methods',
    dsl: `
class TestPipeline < Pipeline
end
`.trim(),
    filename: 'test_pipeline.pipeline.rb',
    expectClass: 'Cambium::CompileError',
    expectMessage: 'No public methods found on TestPipeline.',
  },
  {
    name: 'pipeline: branch_on missing default block',
    dsl: `
class TestPipeline < Pipeline
  input :doc, schema: AnalysisReport
  step :analyze, gen: Analyzer, method: :analyze, with: { ctx: bind(:input).doc }
  branch_on bind(:analyze).severity do
    match :high do
      step :remediate, gen: Analyzer, method: :analyze
    end
  end
  def review(doc)
  end
end
`.trim(),
    filename: 'test_pipeline.pipeline.rb',
    expectClass: 'Cambium::CompileError',
    expectMessage: 'branch_on on TestPipeline requires an explicit `default do ... end` block in v1.',
  },
  {
    name: 'pipeline: step references undeclared prior step',
    dsl: `
class TestPipeline < Pipeline
  step :analyze, gen: Analyzer, method: :analyze, with: { ctx: bind(:nonexistent).field }
  def review(doc)
  end
end
`.trim(),
    filename: 'test_pipeline.pipeline.rb',
    expectClass: 'Cambium::CompileError',
    expectMessage: 'operator :analyze on TestPipeline references bind(:nonexistent)',
  },
  {
    name: 'pipeline: prewarm non-Boolean',
    dsl: `
class TestPipeline < Pipeline
  fan_out :reviewers, collect_into: :reviews do
    branch :security, agent: SecurityReviewer, method: :review
    prewarm :yes
  end
  def review(doc)
  end
end
`.trim(),
    filename: 'test_pipeline.pipeline.rb',
    expectClass: 'ArgumentError',
    expectMessage: 'prewarm: must be true or false',
  },
]
