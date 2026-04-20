import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * RED-237: workspace-configurable model aliases.
 *
 * Aliases are resolved at compile time — the runner never sees the
 * symbol, only the literal. Tests shell out to the Ruby compiler
 * exactly like the other compile_*.test.ts files and assert on IR
 * shape or stderr.
 */

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt'

function compile(genPath: string, method: string, arg: string, cwd?: string): any {
  const stdout = execSync(
    `ruby ${cwd ? process.cwd() : '.'}/ruby/cambium/compile.rb ${genPath} --method ${method} --arg ${arg}`,
    { encoding: 'utf8', cwd: cwd ?? process.cwd() },
  )
  return JSON.parse(stdout)
}

function compileExpectError(genPath: string, method: string, arg: string, cwd?: string): string {
  try {
    execSync(
      `ruby ${cwd ? process.cwd() : '.'}/ruby/cambium/compile.rb ${genPath} --method ${method} --arg ${arg}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: cwd ?? process.cwd() },
    )
    throw new Error('Expected compile to fail, but it succeeded')
  } catch (e: any) {
    return String(e.stderr ?? '') + String(e.message ?? '')
  }
}

function writeGen(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red237-'))
  const path = join(dir, 'aliased.cmb.rb')
  writeFileSync(path, body.trim())
  return path
}

describe('model aliases (RED-237)', () => {
  it('resolves `model :default` to the literal from packages/cambium/app/config/models.rb', () => {
    // The workspace's models.rb defines :default → "omlx:Qwen3.5-27B-4bit".
    // A fresh gen that references :default gets that literal in its IR.
    const gen = writeGen(`
class AliasedGen < GenModel
  model :default
  system "inline system prompt"
  returns AnalysisReport
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'analyze', FIXTURE_ARG)
    expect(ir.model.id).toBe('omlx:Qwen3.5-27B-4bit')
  })

  it('resolves `model :fast` to the distinct literal for the fast alias', () => {
    const gen = writeGen(`
class FastGen < GenModel
  model :fast
  system "inline"
  returns AnalysisReport
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'analyze', FIXTURE_ARG)
    expect(ir.model.id).toBe('omlx:gemma-4-31b-it-8bit')
  })

  it('passes a literal `model "omlx:..."` string through unchanged', () => {
    const gen = writeGen(`
class LiteralGen < GenModel
  model "omlx:some-other-model-name"
  system "inline"
  returns AnalysisReport
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'analyze', FIXTURE_ARG)
    expect(ir.model.id).toBe('omlx:some-other-model-name')
  })

  it('errors on an undefined alias with the available list', () => {
    const gen = writeGen(`
class TypoGen < GenModel
  model :defualt
  system "inline"
  returns AnalysisReport
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const stderr = compileExpectError(gen, 'analyze', FIXTURE_ARG)
    expect(stderr).toMatch(/unknown model alias :defualt/)
    expect(stderr).toMatch(/Available: \[.*default.*\]/)
  })

  it('resolves :embedding on a memory decl to the literal', () => {
    const gen = writeGen(`
class EmbedAliasGen < GenModel
  model :default
  system "inline"
  returns AnalysisReport
  memory :facts, strategy: :semantic, top_k: 5, embed: :embedding
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'analyze', FIXTURE_ARG)
    expect(ir.policies.memory[0].embed).toBe('omlx:bge-small-en')
  })

  it('resolves :embedding on a named pool (workspace fallback path)', () => {
    // Create an isolated workspace with a pool that uses `embed :embedding`
    // and a config file that defines :embedding. This exercises the full
    // pool-embed resolution path.
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red237-pool-'))
    const poolDir = join(dir, 'packages', 'cambium', 'app', 'memory_pools')
    const configDir = join(dir, 'packages', 'cambium', 'app', 'config')
    execSync(`mkdir -p ${poolDir} ${configDir}`)
    writeFileSync(join(poolDir, 'pool_using_alias.pool.rb'), `
strategy :semantic
embed    :my_embed
keyed_by :team_id
`.trim())
    writeFileSync(join(configDir, 'models.rb'), `
default "omlx:Qwen3.5-27B-4bit"
my_embed "omlx:another-embed"
`.trim())

    const genPath = join(dir, 'g.cmb.rb')
    writeFileSync(genPath, `
class PoolAliasGen < GenModel
  model :default
  system "inline"
  returns AnalysisReport
  memory :facts, scope: :pool_using_alias, top_k: 3
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`.trim())

    const repoRoot = process.cwd()
    const stdout = execSync(
      `ruby ${repoRoot}/ruby/cambium/compile.rb ${genPath} --method analyze --arg ${repoRoot}/${FIXTURE_ARG}`,
      { encoding: 'utf8', cwd: dir },
    )
    const ir = JSON.parse(stdout)
    expect(ir.policies.memory_pools.pool_using_alias.embed).toBe('omlx:another-embed')
    expect(ir.policies.memory[0].embed).toBe('omlx:another-embed')
  })

  it('is a no-op for workspaces with no models.rb (pure literals still work)', () => {
    // Run in a tmpdir with no app/config/models.rb — the compile should
    // succeed for a gen that uses only literals, and fail with the
    // "no aliases defined" hint for one that uses a symbol.
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red237-noconfig-'))
    const genLiteral = join(dir, 'literal.cmb.rb')
    writeFileSync(genLiteral, `
class LiteralGen < GenModel
  model "omlx:fine"
  system "inline"
  returns AnalysisReport
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`.trim())
    const repoRoot = process.cwd()
    const stdout = execSync(
      `ruby ${repoRoot}/ruby/cambium/compile.rb ${genLiteral} --method analyze --arg ${repoRoot}/${FIXTURE_ARG}`,
      { encoding: 'utf8', cwd: dir },
    )
    expect(JSON.parse(stdout).model.id).toBe('omlx:fine')

    const genAlias = join(dir, 'alias.cmb.rb')
    writeFileSync(genAlias, `
class AliasGen < GenModel
  model :default
  system "inline"
  returns AnalysisReport
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`.trim())
    let stderr = ''
    try {
      execSync(
        `ruby ${repoRoot}/ruby/cambium/compile.rb ${genAlias} --method analyze --arg ${repoRoot}/${FIXTURE_ARG}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: dir },
      )
      throw new Error('Expected compile to fail')
    } catch (e: any) {
      stderr = String(e.stderr ?? '') + String(e.message ?? '')
    }
    expect(stderr).toMatch(/no aliases defined — create app\/config\/models\.rb/)
  })

  it('rejects a non-string alias value at config load time', () => {
    // Write a models.rb with a bad value type; compile should fail.
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red237-badconfig-'))
    const configDir = join(dir, 'packages', 'cambium', 'app', 'config')
    execSync(`mkdir -p ${configDir}`)
    writeFileSync(join(configDir, 'models.rb'), `default 42`)

    const gen = join(dir, 'g.cmb.rb')
    writeFileSync(gen, `
class G < GenModel
  model :default
  system "inline"
  returns AnalysisReport
  def analyze(x)
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
        `ruby ${repoRoot}/ruby/cambium/compile.rb ${gen} --method analyze --arg ${repoRoot}/${FIXTURE_ARG}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: dir },
      )
      throw new Error('Expected compile to fail')
    } catch (e: any) {
      stderr = String(e.stderr ?? '') + String(e.message ?? '')
    }
    expect(stderr).toMatch(/must map to a String literal/)
  })

  // ── RED-287: engine-mode suppression ────────────────────────────────
  //
  // A gen inside an engine folder (cambium.engine.json sibling) must
  // NOT pick up an ancestor workspace's models.rb. Engines own their
  // own model choices — and currently don't support workspace-level
  // aliases at all, so referencing :default from an engine is a compile
  // error, not a silent pickup from the surrounding cambium repo.

  it('engine mode: model :alias fails — aliases are not loaded inside an engine folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red287-engine-alias-'))
    writeFileSync(join(dir, 'cambium.engine.json'), '{}')
    const gen = join(dir, 'inner.cmb.rb')
    writeFileSync(gen, `
class EngineAliasGen < GenModel
  model :default
  system "inline"
  returns AnalysisReport
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`.trim())
    const stderr = compileExpectError(gen, 'analyze', FIXTURE_ARG)
    expect(stderr).toMatch(/unknown model alias :default/)
  })

  it('engine mode: literal model strings compile unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red287-engine-literal-'))
    writeFileSync(join(dir, 'cambium.engine.json'), '{}')
    const gen = join(dir, 'inner.cmb.rb')
    writeFileSync(gen, `
class EngineLiteralGen < GenModel
  model "omlx:some-model"
  system "inline"
  returns AnalysisReport
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`.trim())
    const ir = compile(gen, 'analyze', FIXTURE_ARG)
    expect(ir.model.id).toBe('omlx:some-model')
  })
})
