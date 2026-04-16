import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * RED-239 v2: workspace-level memory policy.
 *
 * Each test spins up an isolated tmpdir workspace with its own
 * packages/cambium/app/config/memory_policy.rb (and any memory pool
 * it needs), writes a gen under that tmpdir, and runs the Ruby
 * compiler with cwd=tmpdir so the fallback search path resolves to
 * the test's isolated files. Asserts on stdout IR for success cases
 * or stderr for compile errors.
 */

const FIXTURE = 'packages/cambium/examples/fixtures/incident.txt'

type WorkspaceLayout = {
  policy?: string
  pools?: Record<string, string>
  gen: string
}

function setupWorkspace(layout: WorkspaceLayout): { dir: string; genPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red239v2-'))
  mkdirSync(join(dir, 'packages', 'cambium', 'app', 'config'), { recursive: true })
  mkdirSync(join(dir, 'packages', 'cambium', 'app', 'memory_pools'), { recursive: true })

  if (layout.policy) {
    writeFileSync(join(dir, 'packages', 'cambium', 'app', 'config', 'memory_policy.rb'), layout.policy.trim())
  }
  if (layout.pools) {
    for (const [name, body] of Object.entries(layout.pools)) {
      writeFileSync(join(dir, 'packages', 'cambium', 'app', 'memory_pools', `${name}.pool.rb`), body.trim())
    }
  }

  const genPath = join(dir, 'g.cmb.rb')
  writeFileSync(genPath, layout.gen.trim())
  return { dir, genPath }
}

function compile(workspace: ReturnType<typeof setupWorkspace>): { ir: any | null; stderr: string } {
  const repoRoot = process.cwd()
  try {
    const stdout = execSync(
      `ruby ${repoRoot}/ruby/cambium/compile.rb ${workspace.genPath} --method analyze --arg ${repoRoot}/${FIXTURE}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace.dir },
    )
    return { ir: JSON.parse(stdout), stderr: '' }
  } catch (e: any) {
    return { ir: null, stderr: String(e.stderr ?? '') + String(e.message ?? '') }
  }
}

const GEN_TEMPLATE = (body: string) => `
class G < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  ${body}
  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`

describe('workspace memory policy (RED-239 v2)', () => {
  it('no policy file → compiles as-is (policy layer is opt-in)', () => {
    const ws = setupWorkspace({
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log, retain: "1d"`),
    })
    const { ir, stderr } = compile(ws)
    expect(stderr).toBe('')
    expect(ir.policies.memory[0].retain.ttl_seconds).toBe(86400)
  })

  it('happy path: policy present, gen complies, IR passes through', () => {
    const ws = setupWorkspace({
      policy: `max_ttl "90d"\nmax_entries 10_000`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log, retain: "30d"`),
    })
    const { ir, stderr } = compile(ws)
    expect(stderr).toBe('')
    expect(ir.policies.memory[0].retain.ttl_seconds).toBe(2592000)
  })

  it('max_ttl enforced: gen retain > ceiling → compile error', () => {
    const ws = setupWorkspace({
      policy: `max_ttl "30d"`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log, retain: "90d"`),
    })
    const { ir, stderr } = compile(ws)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/exceeds workspace max_ttl/)
  })

  it('default_ttl applied: gen with no retain gets the default', () => {
    const ws = setupWorkspace({
      policy: `default_ttl "30d"`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log`),
    })
    const { ir, stderr } = compile(ws)
    expect(stderr).toBe('')
    expect(ir.policies.memory[0].retain).toEqual({ ttl_seconds: 2592000 })
  })

  it('default_ttl does NOT override an explicit retain on the decl', () => {
    const ws = setupWorkspace({
      policy: `default_ttl "30d"`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log, retain: "7d"`),
    })
    const { ir } = compile(ws)
    expect(ir.policies.memory[0].retain.ttl_seconds).toBe(604800)
  })

  it('default_ttl cannot exceed max_ttl (contradiction at policy load)', () => {
    const ws = setupWorkspace({
      policy: `max_ttl "30d"\ndefault_ttl "90d"`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log`),
    })
    const { ir, stderr } = compile(ws)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/default_ttl .* exceeds max_ttl/)
  })

  it('max_entries enforced: gen cap > ceiling → compile error', () => {
    const ws = setupWorkspace({
      policy: `max_entries 1000`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log, retain: { max_entries: 5000 }`),
    })
    const { ir, stderr } = compile(ws)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/exceeds workspace max_entries/)
  })

  it('require_keyed_by_for: :global scope without keyed_by → error', () => {
    const ws = setupWorkspace({
      policy: `require_keyed_by_for scope: :global`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log, scope: :global`),
    })
    const { ir, stderr } = compile(ws)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/requires `keyed_by:`/)
  })

  it('require_keyed_by_for: :global with keyed_by declared → OK', () => {
    const ws = setupWorkspace({
      policy: `require_keyed_by_for scope: :global`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log, scope: :global, keyed_by: :user_id`),
    })
    const { ir, stderr } = compile(ws)
    expect(stderr).toBe('')
    expect(ir.policies.memory[0].keyed_by).toBe('user_id')
  })

  it('ban_scope :global → any :global decl is a compile error', () => {
    const ws = setupWorkspace({
      policy: `ban_scope :global`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log, scope: :global`),
    })
    const { ir, stderr } = compile(ws)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/scope :global is banned/)
  })

  it('allowed_pools enforced: pool not in list → error', () => {
    const ws = setupWorkspace({
      policy: `allowed_pools :billing`,
      pools: {
        support_team: `strategy :log\nkeyed_by :team_id`,
      },
      gen: GEN_TEMPLATE(`memory :conv, scope: :support_team`),
    })
    const { ir, stderr } = compile(ws)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/not in the workspace pool allowlist/)
  })

  it('allowed_pools: pool in list → OK', () => {
    const ws = setupWorkspace({
      policy: `allowed_pools :support_team, :billing`,
      pools: {
        support_team: `strategy :log\nkeyed_by :team_id`,
      },
      gen: GEN_TEMPLATE(`memory :conv, scope: :support_team`),
    })
    const { ir, stderr } = compile(ws)
    expect(stderr).toBe('')
    expect(ir.policies.memory[0].scope).toBe('support_team')
  })

  it('pool-side retain above max_ttl → compile error (enforcement reaches into pools)', () => {
    const ws = setupWorkspace({
      policy: `max_ttl "30d"`,
      pools: {
        support_team: `strategy :log\nkeyed_by :team_id\nretain "90d"`,
      },
      gen: GEN_TEMPLATE(`memory :conv, scope: :support_team`),
    })
    const { ir, stderr } = compile(ws)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/memory_pool :support_team retain.ttl_seconds/)
  })

  it('unknown directive in memory_policy.rb → explicit error, not silent no-op', () => {
    const ws = setupWorkspace({
      policy: `forever_cache true`,
      gen: GEN_TEMPLATE(`memory :conv, strategy: :log`),
    })
    const { ir, stderr } = compile(ws)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/unknown directive.*forever_cache/)
  })
})
