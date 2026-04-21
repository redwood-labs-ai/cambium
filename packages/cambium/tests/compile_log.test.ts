/**
 * RED-282 / RED-302: `log` primitive compile-time tests.
 *
 * Covers: inline form, profile form, mutex between the two, granularity
 * + include validation, unknown-profile error, name-regex guard,
 * multiple-log-calls accumulation, IR shape.
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FIXTURE = 'packages/cambium/examples/fixtures/incident.txt'

type Workspace = { profiles?: Record<string, string>; gen: string }

function setupWorkspace(ws: Workspace): { dir: string; genPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red302-'))
  mkdirSync(join(dir, 'packages', 'cambium', 'app', 'log_profiles'), { recursive: true })

  if (ws.profiles) {
    for (const [name, body] of Object.entries(ws.profiles)) {
      writeFileSync(
        join(dir, 'packages', 'cambium', 'app', 'log_profiles', `${name}.log_profile.rb`),
        body.trim(),
      )
    }
  }

  const genPath = join(dir, 'g.cmb.rb')
  writeFileSync(genPath, ws.gen.trim())
  return { dir, genPath }
}

function compile(ws: Workspace): { ir: any | null; stderr: string } {
  const { dir, genPath } = setupWorkspace(ws)
  const repoRoot = process.cwd()
  try {
    const stdout = execSync(
      `ruby ${repoRoot}/ruby/cambium/compile.rb ${genPath} --method analyze --arg ${repoRoot}/${FIXTURE}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: dir },
    )
    return { ir: JSON.parse(stdout), stderr: '' }
  } catch (e: any) {
    return { ir: null, stderr: String(e.stderr ?? '') + String(e.message ?? '') }
  }
}

const GEN = (body: string) => `
class G < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  ${body}

  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`

describe('log primitive (RED-282 / RED-302)', () => {
  describe('inline form', () => {
    it('log :stdout produces a single destination entry with defaults', () => {
      const { ir, stderr } = compile({ gen: GEN('log :stdout') })
      expect(stderr).toBe('')
      expect(ir?.policies?.log).toEqual([
        {
          destination: 'stdout',
          include: [],
          granularity: 'run',
        },
      ])
      expect(ir?.policies?.log_profiles).toEqual([])
    })

    it('log :datadog with include + granularity captures all opts', () => {
      const { ir, stderr } = compile({
        gen: GEN('log :datadog, include: [:signals, :tool_calls], granularity: :run, endpoint: "https://example.com", api_key_env: "DD_KEY"'),
      })
      expect(stderr).toBe('')
      expect(ir?.policies?.log).toEqual([
        {
          destination: 'datadog',
          include: ['signals', 'tool_calls'],
          granularity: 'run',
          endpoint: 'https://example.com',
          api_key_env: 'DD_KEY',
        },
      ])
    })

    it('multiple log calls accumulate', () => {
      const { ir, stderr } = compile({
        gen: GEN('log :stdout\n  log :datadog, include: [:signals]'),
      })
      expect(stderr).toBe('')
      expect(ir?.policies?.log).toHaveLength(2)
      expect(ir?.policies?.log[0].destination).toBe('stdout')
      expect(ir?.policies?.log[1].destination).toBe('datadog')
    })

    it('granularity :step is accepted', () => {
      const { ir, stderr } = compile({ gen: GEN('log :stdout, granularity: :step') })
      expect(stderr).toBe('')
      expect(ir?.policies?.log[0].granularity).toBe('step')
    })

    it('rejects unknown include field', () => {
      const { ir, stderr } = compile({ gen: GEN('log :stdout, include: [:bogus]') })
      expect(ir).toBeNull()
      expect(stderr).toMatch(/unknown field\(s\).*:bogus/)
    })

    it('rejects invalid granularity', () => {
      const { ir, stderr } = compile({ gen: GEN('log :stdout, granularity: :hourly') })
      expect(ir).toBeNull()
      expect(stderr).toMatch(/granularity.*:run or :step/)
    })

    it('rejects a non-symbol positional arg', () => {
      const { ir, stderr } = compile({ gen: GEN('log "datadog"') })
      expect(ir).toBeNull()
      expect(stderr).toMatch(/positional arg must be a Symbol/)
    })

    it('rejects an unknown kwarg', () => {
      const { ir, stderr } = compile({ gen: GEN('log :stdout, gibberish: true') })
      expect(ir).toBeNull()
      expect(stderr).toMatch(/unknown option\(s\)/)
    })
  })

  describe('profile form', () => {
    const APP_DEFAULT = `
destination :stdout
destination :datadog, endpoint: "https://dd.example.com", api_key_env: "CAMBIUM_DATADOG_API_KEY"
include :signals, :tool_calls, :repair_attempts
granularity :run
    `

    it('log :app_default resolves a profile file into inlined destinations', () => {
      const { ir, stderr } = compile({
        profiles: { app_default: APP_DEFAULT },
        gen: GEN('log :app_default'),
      })
      expect(stderr).toBe('')
      expect(ir?.policies?.log).toHaveLength(2)
      const [stdoutEntry, ddEntry] = ir!.policies.log
      expect(stdoutEntry).toMatchObject({
        destination: 'stdout',
        include: ['signals', 'tool_calls', 'repair_attempts'],
        granularity: 'run',
        _profile: 'app_default',
      })
      expect(ddEntry).toMatchObject({
        destination: 'datadog',
        endpoint: 'https://dd.example.com',
        api_key_env: 'CAMBIUM_DATADOG_API_KEY',
        include: ['signals', 'tool_calls', 'repair_attempts'],
        granularity: 'run',
        _profile: 'app_default',
      })
      expect(ir?.policies?.log_profiles).toEqual(['app_default'])
    })

    it('rejects profile + inline opts in the same call', () => {
      const { ir, stderr } = compile({
        profiles: { app_default: APP_DEFAULT },
        gen: GEN('log :app_default, include: [:signals]'),
      })
      expect(ir).toBeNull()
      expect(stderr).toMatch(/cannot mix profile reference and inline options/)
    })

    it('unknown profile (no file exists) falls through to inline form', () => {
      // Per design: if no profile file, treat as inline. Runtime validates destination name.
      const { ir, stderr } = compile({ gen: GEN('log :app_default') })
      expect(stderr).toBe('')
      expect(ir?.policies?.log).toEqual([
        {
          destination: 'app_default',
          include: [],
          granularity: 'run',
        },
      ])
    })

    it('empty profile file errors clearly', () => {
      const { ir, stderr } = compile({
        profiles: { app_default: '# empty\ngranularity :run' },
        gen: GEN('log :app_default'),
      })
      expect(ir).toBeNull()
      expect(stderr).toMatch(/declares no destinations/)
    })

    it('profile with an unknown include raises at profile-load time', () => {
      const { ir, stderr } = compile({
        profiles: { app_default: 'destination :stdout\ninclude :bogus' },
        gen: GEN('log :app_default'),
      })
      expect(ir).toBeNull()
      expect(stderr).toMatch(/unknown field :bogus/)
    })

    it('profile with invalid granularity errors at profile-load time', () => {
      const { ir, stderr } = compile({
        profiles: { app_default: 'destination :stdout\ngranularity :weekly' },
        gen: GEN('log :app_default'),
      })
      expect(ir).toBeNull()
      expect(stderr).toMatch(/granularity.*:run or :step/)
    })
  })

  describe('absent log primitive', () => {
    it('gen with no log declaration produces empty log array', () => {
      const { ir, stderr } = compile({ gen: GEN('# no log') })
      expect(stderr).toBe('')
      expect(ir?.policies?.log).toEqual([])
      expect(ir?.policies?.log_profiles).toEqual([])
    })
  })
})
