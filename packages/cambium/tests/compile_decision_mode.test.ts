/**
 * #275 — `mode :decision`: DSL + compiler (DEC-002/003/004/005/009/012).
 *
 * Tests shell out to the Ruby compiler and assert on IR shape and on
 * CompileError messages, exactly like the sibling compile_*.test.ts and
 * golden/rejection.test.ts files.
 *
 * Run offline: no LLM, no secrets.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.cwd()
const COMPILE = 'ruby/cambium/compile.rb'

const tempDirs: string[] = []
afterEach(() => {
  const dir = tempDirs.pop()
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

function writeGen(body: string, filename = 'test_gen.cmb.rb'): string {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-275-'))
  tempDirs.push(dir)
  const path = join(dir, filename)
  writeFileSync(path, body.trim() + '\n')
  return path
}

/** Compile and expect success. Returns the parsed IR. */
function compileOk(genPath: string, method: string): any {
  const result = spawnSync('ruby', [COMPILE, genPath, '--method', method], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 * 1024 * 1024,
  })
  expect(result.status, `expected successful compile, got stderr:\n${result.stderr}`).toBe(0)
  return JSON.parse(result.stdout)
}

/** Compile and expect a non-zero exit. Returns stderr. */
function compileFail(genPath: string, method: string): string {
  const result = spawnSync('ruby', [COMPILE, genPath, '--method', method], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 * 1024 * 1024,
  })
  expect(result.status, `expected a CompileError, but compile succeeded:\n${result.stdout}`).not.toBe(0)
  return result.stderr
}

// The example gen from PLAN-275 (DEC-016 mints the real file at
// app/gens/ticket_router.cmb.rb in STEP-004; this inline copy pins the
// IR shape independently of that step's ordering).
const TICKET_ROUTER = `
class TicketRouter < Cambium::GenModel
  describe "Routes a support ticket to the team that should handle it and flags urgency."
  model "typesafe:jev-latest"
  mode :decision
  system "You are a router."

  returns do
    field :department, String,
      description: "Which team should handle this ticket?",
      enum: {
        billing:   "Payment, invoice, or subscription issues",
        technical: "Bugs, errors, or integration failures",
        sales:     "Pricing, plans, or account questions",
      }
    field :is_urgent, Boolean,
      description: "The ticket conveys urgency or time-sensitivity"
  end

  def route(document); end
end
`

describe('#275: mode :decision — IR shape', () => {
  it('emits mode, decision.questions (declaration order), and a closed _decision schema block', () => {
    const ir = compileOk(writeGen(TICKET_ROUTER), 'route')

    expect(ir.mode).toBe('decision')
    expect(Object.keys(ir.decision.questions)).toEqual(['department', 'is_urgent'])
    expect(ir.decision.questions.department).toEqual({
      kind: 'choice',
      instructions: 'Which team should handle this ticket?',
      options: {
        billing: 'Payment, invoice, or subscription issues',
        technical: 'Bugs, errors, or integration failures',
        sales: 'Pricing, plans, or account questions',
      },
    })
    expect(ir.decision.questions.is_urgent).toEqual({
      kind: 'boolean',
      instructions: 'The ticket conveys urgency or time-sensitivity',
    })

    // returnSchema.enum stays the plain key array (DEC-004) — descriptions
    // travel only through ir.decision, never into the JSON Schema.
    expect(ir.returnSchema.properties.department.enum).toEqual(['billing', 'technical', 'sales'])

    // DEC-009/DEC-009a/DEC-009b: the compiler-added `_decision` envelope, a
    // closed object — except (a) the `probabilities` sub-object of a
    // choice entry, which keeps the declared option keys as `properties`
    // (documentation + typing) but drops `required`/`additionalProperties:
    // false`: the keys are Cambium's, but the MAP is the vendor's
    // (AUD-002); and (b) `confidence` on a choice entry, which stays
    // declared but is not `required` — the vendor shows it in every
    // documented example but does not guarantee it in writing
    // (AUD-275-015/DEC-009b). The boolean entry is the vendor's own single
    // `{ probability }` number — no synthesized `{ true, false }`
    // complement (AUD-010).
    expect(ir.returnSchema.properties._decision).toEqual({
      type: 'object',
      required: ['department', 'is_urgent'],
      additionalProperties: false,
      properties: {
        department: {
          type: 'object',
          required: ['probabilities'],
          additionalProperties: false,
          properties: {
            confidence: { type: 'number' },
            probabilities: {
              type: 'object',
              properties: {
                billing: { type: 'number' },
                technical: { type: 'number' },
                sales: { type: 'number' },
              },
            },
          },
        },
        is_urgent: {
          type: 'object',
          required: ['probability'],
          additionalProperties: false,
          properties: {
            probability: { type: 'number' },
          },
        },
      },
    })
    expect(ir.returnSchema.required).toEqual(['department', 'is_urgent', '_decision'])
  })

  it('array enum: inside decision mode yields all-null options', () => {
    const gen = `
class DecisionArrayEnum < Cambium::GenModel
  model "typesafe:jev-latest"
  mode :decision
  returns do
    field :x, String, description: "x?", enum: %w[a b]
  end
  def go(ctx); end
end
`
    const ir = compileOk(writeGen(gen), 'go')
    expect(ir.decision.questions.x).toEqual({
      kind: 'choice',
      instructions: 'x?',
      options: { a: null, b: null },
    })
  })

  it('a Boolean field with enum: is still refused by the existing "enum on String only" error, not a decision-mode-specific one', () => {
    const gen = `
class DecisionBoolEnum < Cambium::GenModel
  model "typesafe:jev-latest"
  mode :decision
  returns do
    field :x, Boolean, description: "x?", enum: %w[a b]
  end
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain("field 'x' uses `enum:` but is not a String")
    expect(stderr).toContain('CompileError')
  })
})

describe('#275: mode :decision — declaration compatibility (DEC-012)', () => {
  const BASE_RETURNS = `
  returns do
    field :ok, Boolean, description: "ok?"
  end
`

  const cases: Array<{ name: string; model: string; extra: string; expectNames: string[] }> = [
    {
      name: '`returns :Symbol`',
      model: 'typesafe:jev-latest',
      extra: '', // returns block replaced below
      expectNames: ['`returns :Symbol`'],
    },
    {
      name: '`corrects`',
      model: 'typesafe:jev-latest',
      extra: 'corrects :math',
      expectNames: ['`corrects`'],
    },
    {
      name: '`constrain`',
      model: 'typesafe:jev-latest',
      extra: 'constrain :tone',
      expectNames: ['`constrain`'],
    },
    {
      name: '`grounded_in`',
      model: 'typesafe:jev-latest',
      extra: 'grounded_in :document',
      expectNames: ['`grounded_in`'],
    },
    {
      name: '`enrich`',
      model: 'typesafe:jev-latest',
      extra: 'enrich(:context_field) { agent :SomeAgent, method: :run }',
      expectNames: ['`enrich`'],
    },
    {
      name: '`temperature`',
      model: 'typesafe:jev-latest',
      extra: 'temperature 0.5',
      expectNames: ['`temperature`'],
    },
    {
      name: '`max_tokens`',
      model: 'typesafe:jev-latest',
      extra: 'max_tokens 100',
      expectNames: ['`max_tokens`'],
    },
    {
      name: '`effort`',
      // effort is Anthropic-only at the existing RED-325 check, which runs
      // before the decision-mode check — an Anthropic model id is required
      // to reach OUR refusal rather than the pre-existing provider check.
      model: 'anthropic:claude-opus',
      extra: 'effort :low',
      expectNames: ['`effort`'],
    },
    {
      name: '`exclude_from_prefix`',
      model: 'typesafe:jev-latest',
      extra: 'exclude_from_prefix :some_key',
      expectNames: ['`exclude_from_prefix`'],
    },
    {
      name: '`writes_memory_via`',
      model: 'typesafe:jev-latest',
      extra: 'writes_memory_via :some_agent',
      expectNames: ['`writes_memory_via`'],
    },
    {
      name: '`reads_trace_of`',
      model: 'typesafe:jev-latest',
      extra: 'reads_trace_of :some_agent',
      expectNames: ['`reads_trace_of`'],
    },
    {
      // #275 DEC-012a (closes AUD-275-005): memory reads are appended to
      // ir.system (flattened into state.system), not routed through
      // state.context as DEC-012 originally assumed — refused until a
      // design opens state.context.memory.
      name: '`memory`',
      model: 'typesafe:jev-latest',
      extra: 'memory :recent, strategy: :sliding_window, scope: :session, size: 5',
      expectNames: ['`memory`'],
    },
  ]

  it.each(cases.map(c => [c.name, c] as [string, typeof cases[number]]))(
    '%s is a CompileError naming the declaration',
    (_name, tc) => {
      const returnsBlock = tc.name === '`returns :Symbol`' ? '  returns :Something\n' : BASE_RETURNS
      const gen = `
class DecisionRefusal < Cambium::GenModel
  model "${tc.model}"
  mode :decision
  ${tc.extra}
${returnsBlock}
  def go(ctx); end
end
`
      const stderr = compileFail(writeGen(gen), 'go')
      expect(stderr).toContain('CompileError')
      expect(stderr).toContain('is not available in `mode :decision`')
      for (const name of tc.expectNames) {
        expect(stderr).toContain(name)
      }
    },
  )

  it('mode :decision with no `returns do … end` block is a CompileError', () => {
    const gen = `
class DecisionNoReturns < Cambium::GenModel
  model "typesafe:jev-latest"
  mode :decision
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain('CompileError')
    expect(stderr).toContain('mode :decision requires a `returns do … end` block')
  })

  it('`optional: true` on a decision-mode field is a CompileError naming the field', () => {
    const gen = `
class DecisionOptionalField < Cambium::GenModel
  model "typesafe:jev-latest"
  mode :decision
  returns do
    field :x, Boolean, description: "x?", optional: true
  end
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain("field 'x'")
    expect(stderr).toContain('optional: true')
  })

  it('a field with no `description:` in decision mode is a CompileError naming the field', () => {
    const gen = `
class DecisionNoFieldDescription < Cambium::GenModel
  model "typesafe:jev-latest"
  mode :decision
  returns do
    field :x, Boolean
  end
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain("field 'x'")
    expect(stderr).toContain('description:')
  })

  it('a non-String/Boolean field (e.g. Integer) in decision mode is a CompileError naming the field and its type', () => {
    const gen = `
class DecisionIntField < Cambium::GenModel
  model "typesafe:jev-latest"
  mode :decision
  returns do
    field :x, Integer, description: "x?"
  end
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain("field 'x'")
    expect(stderr).toContain("type 'integer'")
  })
})

describe('#275: DEC-004 reverse direction — Hash enum: outside mode :decision', () => {
  it('is a CompileError naming the field', () => {
    const gen = `
class HashEnumOutsideDecision < Cambium::GenModel
  model "omlx:test"
  returns do
    field :x, String, description: "x", enum: { a: "A", b: "B" }
  end
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain('CompileError')
    expect(stderr).toContain("field 'x'")
    expect(stderr).toContain('only available in `mode :decision`')
  })
})

describe('#275 AUD-275-007/SEC-001: `_decision` is a reserved field name in mode :decision', () => {
  it('is a CompileError naming the field, not an invalid IR', () => {
    const gen = `
class DecisionReservedField < Cambium::GenModel
  model "typesafe:jev-latest"
  mode :decision
  returns do
    field :_decision, String, description: "Q", enum: { billing: "b", technical: "t" }
  end
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain('CompileError')
    expect(stderr).toContain("field '_decision' is reserved")
  })
})

describe('#275 AUD-275-011: Hash enum: keys colliding after `.to_s`', () => {
  it('is a CompileError naming both keys', () => {
    const gen = `
class DecisionEnumCollision < Cambium::GenModel
  model "typesafe:jev-latest"
  mode :decision
  returns do
    field :d, String, description: "Q", enum: { "billing" => "x", billing: "y" }
  end
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain('CompileError')
    expect(stderr).toContain("field 'd'")
    expect(stderr).toContain('"billing"')
    expect(stderr).toContain(':billing')
  })
})

describe('#275 AUD-275-012/DEC-018: `mode` is a closed enum', () => {
  it('an unknown mode value is a CompileError naming it and the valid values', () => {
    const gen = `
class BadMode < Cambium::GenModel
  model "omlx:test"
  mode :Decision
  returns do
    field :x, String, description: "x", enum: %w[a b]
  end
  def go(ctx); end
end
`
    const stderr = compileFail(writeGen(gen), 'go')
    expect(stderr).toContain('CompileError')
    expect(stderr).toContain("'Decision'")
    expect(stderr).toContain('agentic, retro, decision')
  })

  it('the valid string form still compiles', () => {
    const gen = `
class GoodMode < Cambium::GenModel
  model "typesafe:jev-latest"
  mode "decision"
  returns do
    field :x, String, description: "x", enum: %w[a b]
  end
  def go(ctx); end
end
`
    const ir = compileOk(writeGen(gen), 'go')
    expect(ir.mode).toBe('decision')
  })
})

describe('#275: byte-identity — a non-decision gen with an array enum: is untouched', () => {
  it('compiles theme_palette.cmb.rb to exactly the committed golden IR', () => {
    // OQ-004: theme_palette is the one committed golden-IR gen that
    // carries an array `enum:` (returnSchema.properties.mode.enum).
    // Bare mode (no --method) matches how the golden corpus itself
    // compiles every gen (golden/acceptance.test.ts).
    const relPath = 'packages/cambium/app/gens/theme_palette.cmb.rb'
    const result = spawnSync('ruby', [COMPILE, relPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    expect(result.status, `theme_palette.cmb.rb failed to compile:\n${result.stderr}`).toBe(0)

    const snapshotPath = join(REPO_ROOT, 'packages/cambium/tests/golden/ir/gens/theme_palette.json')
    const golden = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    expect(JSON.parse(result.stdout)).toEqual(golden)
  })
})
