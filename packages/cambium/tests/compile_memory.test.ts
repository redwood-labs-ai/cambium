import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * RED-215 phase 2: memory DSL parsing + IR emission.
 *
 * These tests shell out to the Ruby compiler the same way the
 * RED-210 schema-validation test does. The bug class we're guarding
 * against is the same: a primitive that looks right in the DSL but
 * emits malformed or unresolved IR only surfaces at runtime. For
 * memory, the gap is also wider because phase 2 is compile-time-only
 * — the TS runner has no memory execution yet, so these tests are the
 * only line of defense until phase 3.
 */

function compile(genPath: string, method: string, arg: string): any {
  const stdout = execSync(
    `ruby ruby/cambium/compile.rb ${genPath} --method ${method} --arg ${arg}`,
    { encoding: 'utf8' },
  )
  return JSON.parse(stdout)
}

function compileExpectError(genPath: string, method: string, arg: string): string {
  try {
    execSync(
      `ruby ruby/cambium/compile.rb ${genPath} --method ${method} --arg ${arg}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    throw new Error('Expected compile to fail, but it succeeded')
  } catch (e: any) {
    return String(e.stderr ?? '') + String(e.message ?? '')
  }
}

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt'

function writeGen(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red215-'))
  const gen = join(dir, 'mem.cmb.rb')
  writeFileSync(gen, body.trim())
  return gen
}

describe('memory DSL (RED-215 phase 2)', () => {
  it('emits policies.memory with a sliding_window :session decl', () => {
    const gen = writeGen(`
class MemGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :conversation, strategy: :sliding_window, size: 20

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'go', FIXTURE_ARG)
    expect(ir.policies.memory).toEqual([
      { name: 'conversation', scope: 'session', strategy: 'sliding_window', size: 20 },
    ])
    expect(ir.policies.memory_pools).toEqual({})
  })

  it('emits a :global log memory', () => {
    const gen = writeGen(`
class GlobalMemGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :activity_log, strategy: :log, scope: :global

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'go', FIXTURE_ARG)
    expect(ir.policies.memory).toEqual([
      { name: 'activity_log', scope: 'global', strategy: 'log' },
    ])
  })

  it('resolves a named pool, merges pool-owned slots, and carries reader knobs', () => {
    // Relies on packages/cambium/app/memory_pools/support_team.pool.rb
    // which ships a semantic pool with embed + keyed_by.
    const gen = writeGen(`
class PooledMemGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :user_facts, scope: :support_team, top_k: 5

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'go', FIXTURE_ARG)
    expect(ir.policies.memory).toHaveLength(1)
    const m = ir.policies.memory[0]
    expect(m.name).toBe('user_facts')
    expect(m.scope).toBe('support_team')
    expect(m.strategy).toBe('semantic')         // from the pool
    expect(m.embed).toBe('omlx:bge-small-en')   // from the pool
    expect(m.keyed_by).toBe('team_id')          // from the pool
    expect(m.top_k).toBe(5)                     // reader knob from the gen

    expect(ir.policies.memory_pools.support_team).toEqual({
      strategy: 'semantic',
      embed: 'omlx:bge-small-en',
      keyed_by: 'team_id',
    })
  })

  it('errors when a gen tries to override a pool-owned slot', () => {
    const gen = writeGen(`
class OverrideGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :user_facts, scope: :support_team, top_k: 5, keyed_by: :other_key

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/pool is the source of truth/)
    expect(stderr).toMatch(/keyed_by/)
  })

  it('errors when the named pool does not exist', () => {
    const gen = writeGen(`
class MissingPoolGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :x, scope: :nonexistent_pool_for_test

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/Memory pool 'nonexistent_pool_for_test' not found/)
  })

  it('errors on invalid pool name (path-traversal guard)', () => {
    const gen = writeGen(`
class BadNameGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :x, scope: :"../escape"

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/Invalid memory pool name/)
  })

  it('errors when :session scope has no strategy', () => {
    const gen = writeGen(`
class NoStrategyGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :x, scope: :session

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/needs .strategy:./)
  })

  it('errors when :semantic session scope is missing an embed model', () => {
    const gen = writeGen(`
class SemNoEmbedGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :x, strategy: :semantic

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/strategy :semantic but no .embed:. model/)
  })

  it('errors on unknown memory option', () => {
    const gen = writeGen(`
class UnknownOptGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :x, strategy: :log, bogus_opt: true

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/unknown option.*bogus_opt/)
  })

  it('errors on invalid strategy symbol', () => {
    const gen = writeGen(`
class BadStratGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :x, strategy: :not_a_strategy

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/strategy must be one of/)
  })

  it('rejects duplicate memory names on the same gen', () => {
    const gen = writeGen(`
class DupMemGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  memory :notes, strategy: :log
  memory :notes, strategy: :sliding_window, size: 10

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/memory slot with this name is already declared/)
  })

  // RED-239: retention parsing
  it('parses retain: "30d" into ttl_seconds', () => {
    const gen = writeGen(`
class RetainDurationGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, strategy: :sliding_window, size: 5, retain: "30d"
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'go', FIXTURE_ARG)
    expect(ir.policies.memory[0].retain).toEqual({ ttl_seconds: 2592000 })
  })

  it('parses retain: { max_entries: N } and retain: { ttl:, max_entries: } hash forms', () => {
    const gen = writeGen(`
class RetainHashGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :cap,  strategy: :log, retain: { max_entries: 100 }
  memory :both, strategy: :log, retain: { ttl: "7d", max_entries: 500 }
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'go', FIXTURE_ARG)
    expect(ir.policies.memory[0].retain).toEqual({ max_entries: 100 })
    expect(ir.policies.memory[1].retain).toEqual({ ttl_seconds: 604800, max_entries: 500 })
  })

  it('rejects a gen-side retain when scope is a named pool (pool-owned)', () => {
    const gen = writeGen(`
class OverrideRetainGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, scope: :support_team, retain: "1d"
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/pool is the source of truth/)
    expect(stderr).toMatch(/retain/)
  })

  it('rejects a malformed retain duration string', () => {
    const gen = writeGen(`
class BadRetainGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, strategy: :log, retain: "thirty-days"
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/must match/)
  })

  it('rejects a zero-duration retain ("0d") — silent no-op would hide the misconfiguration', () => {
    const gen = writeGen(`
class ZeroRetainGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, strategy: :log, retain: "0d"
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/must be positive/)
  })

  it('rejects a retain duration above the 10-year cap — protects TS from arithmetic overflow', () => {
    const gen = writeGen(`
class HugeRetainGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, strategy: :log, retain: "99999d"
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/exceeds the 10-year cap/)
  })

  it('rejects retain hash with unknown keys', () => {
    const gen = writeGen(`
class UnknownRetainKeyGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, strategy: :log, retain: { forever: true }
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/unknown retain key/)
  })

  it('emits write_memory_via and reads_trace_of into IR', () => {
    const gen = writeGen(`
class RetroGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  mode :retro
  reads_trace_of :primary_agent

  memory :notes, strategy: :log
  write_memory_via :MemoryAgent

  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'go', FIXTURE_ARG)
    expect(ir.mode).toBe('retro')
    expect(ir.reads_trace_of).toBe('primary_agent')
    expect(ir.policies.memory_write_via).toBe('MemoryAgent')
  })
})

describe('memory pool loader (RED-215 phase 2)', () => {
  it('rejects a semantic pool missing embed', () => {
    // Isolate this test from the real workspace by running the compiler
    // with cwd set to a tmpdir that has its own packages/cambium/app/
    // memory_pools dir containing just the broken pool. The pool-loader
    // fallback (File.join('packages', 'cambium', 'app', 'memory_pools'))
    // then resolves to our tmpdir, not the real support_team.pool.rb.
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red215-pool-'))
    const poolDir = join(dir, 'packages', 'cambium', 'app', 'memory_pools')
    execSync(`mkdir -p ${poolDir}`)
    writeFileSync(join(poolDir, 'broken_sem.pool.rb'), `
strategy :semantic
keyed_by :team_id
`.trim())
    const gen = join(dir, 'g.cmb.rb')
    writeFileSync(gen, `
class BrokenPoolGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :facts, scope: :broken_sem
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`.trim())

    const repoRoot = process.cwd()
    let stderr = ''
    try {
      execSync(
        `ruby ${repoRoot}/ruby/cambium/compile.rb ${gen} --method go --arg ${repoRoot}/packages/cambium/examples/fixtures/incident.txt`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: dir },
      )
      throw new Error('Expected compile to fail, but it succeeded')
    } catch (e: any) {
      stderr = String(e.stderr ?? '') + String(e.message ?? '')
    }
    expect(stderr).toMatch(/strategy :semantic but has no .embed. model/)
  })

  // RED-238: configurable query source for :semantic memory (literal + arg_field)
  it('emits query: literal string on a :semantic decl', () => {
    const gen = writeGen(`
class QueryLiteralGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :facts, strategy: :semantic, top_k: 3, embed: "omlx:bge-small-en",
         query: "support triage anchor"
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'go', FIXTURE_ARG)
    expect(ir.policies.memory[0].query).toBe('support triage anchor')
    expect(ir.policies.memory[0].arg_field).toBeUndefined()
  })

  it('emits arg_field: name on a :semantic decl', () => {
    const gen = writeGen(`
class ArgFieldGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :facts, strategy: :semantic, top_k: 3, embed: "omlx:bge-small-en",
         arg_field: :question
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'go', FIXTURE_ARG)
    expect(ir.policies.memory[0].arg_field).toBe('question')
    expect(ir.policies.memory[0].query).toBeUndefined()
  })

  it('rejects query: and arg_field: set on the same decl', () => {
    const gen = writeGen(`
class BothQueryFormsGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :facts, strategy: :semantic, top_k: 3, embed: "omlx:bge-small-en",
         query: "literal", arg_field: :question
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/query:.*arg_field:.*mutually exclusive/)
  })

  it('rejects query: on a non-semantic strategy (gen-side strategy)', () => {
    const gen = writeGen(`
class QueryOnLogGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, strategy: :log, query: "literal"
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/only valid on strategy :semantic/)
  })

  it('rejects arg_field: on :sliding_window', () => {
    const gen = writeGen(`
class ArgFieldOnSWGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, strategy: :sliding_window, size: 5, arg_field: :question
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/only valid on strategy :semantic/)
  })

  it('rejects symbolic query: (reserved for RED-241) with a clear pointer', () => {
    const gen = writeGen(`
class SymbolicQueryGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :facts, strategy: :semantic, top_k: 3, embed: "omlx:bge-small-en",
         query: :last_signal_value
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/symbolic .query:. values.*reserved/)
    expect(stderr).toMatch(/RED-241/)
  })

  it('rejects non-string/non-symbol arg_field:', () => {
    const gen = writeGen(`
class BadArgFieldTypeGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :facts, strategy: :semantic, top_k: 3, embed: "omlx:bge-small-en",
         arg_field: 42
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/arg_field:.*must be a Symbol or String/)
  })

  it('rejects query: / arg_field: resolved via a non-semantic pool (post-resolution check)', () => {
    // Relies on a pool where strategy != :semantic. Post-RED-245 the pool
    // search uses `<gen_dir's parent>/<subdir>/`, so we mimic the real
    // workspace layout: gen at `<tmp>/app/gens/g.cmb.rb` makes
    // `<tmp>/app/memory_pools/` resolve as the package-app dir.
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red238-pool-'))
    const poolsDir = join(dir, 'app', 'memory_pools')
    const gensDir = join(dir, 'app', 'gens')
    require('node:fs').mkdirSync(poolsDir, { recursive: true })
    require('node:fs').mkdirSync(gensDir, { recursive: true })
    writeFileSync(
      join(poolsDir, 'log_fixture.pool.rb'),
      `strategy :log\nkeyed_by :tenant_id\n`,
    )
    const gen = join(gensDir, 'g.cmb.rb')
    writeFileSync(
      gen,
      `
class PoolQueryGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, scope: :log_fixture, query: "literal"
  def go(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`.trim(),
    )
    const stderr = compileExpectError(gen, 'go', FIXTURE_ARG)
    expect(stderr).toMatch(/only valid on strategy :semantic/)
    expect(stderr).toMatch(/via pool :log_fixture/)
  })
})
