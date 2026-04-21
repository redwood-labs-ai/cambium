/**
 * RED-273 / RED-305: `cron` primitive compile-time tests.
 *
 * Covers: named vocab → crontab expansion, raw crontab validation,
 * at/tz/method/id kwargs, duplicate-id detection, schedule scope
 * memory pairing validation, IR shape.
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FIXTURE = 'packages/cambium/examples/fixtures/incident.txt'

function compileGen(body: string): { ir: any | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red305-'))
  const genPath = join(dir, 'g.cmb.rb')
  writeFileSync(genPath, body.trim())
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

describe('cron primitive — named vocabulary', () => {
  it('cron :daily with no `at:` defaults to midnight', () => {
    const { ir, stderr } = compileGen(GEN('cron :daily'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules).toEqual([
      expect.objectContaining({
        id: 'g.analyze.daily',
        expression: '0 0 * * *',
        method: 'analyze',
        tz: 'UTC',
        named: 'daily',
      }),
    ])
  })

  it('cron :daily, at: "9:00" produces 0 9 * * *', () => {
    const { ir, stderr } = compileGen(GEN('cron :daily, at: "9:00"'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules?.[0]).toMatchObject({
      id: 'g.analyze.daily',
      expression: '0 9 * * *',
      at: '9:00',
    })
  })

  it('cron :hourly produces 0 * * * *', () => {
    const { ir, stderr } = compileGen(GEN('cron :hourly'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules?.[0].expression).toBe('0 * * * *')
  })

  it('cron :weekdays, at: "9:00" produces 0 9 * * 1-5', () => {
    const { ir, stderr } = compileGen(GEN('cron :weekdays, at: "9:00"'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules?.[0].expression).toBe('0 9 * * 1-5')
  })

  it('cron :weekly, at: "8:00" produces 0 8 * * 0 (Sunday)', () => {
    const { ir, stderr } = compileGen(GEN('cron :weekly, at: "8:00"'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules?.[0].expression).toBe('0 8 * * 0')
  })

  it('cron :every_minute produces * * * * *', () => {
    const { ir, stderr } = compileGen(GEN('cron :every_minute'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules?.[0].expression).toBe('* * * * *')
  })

  it('rejects unknown named vocab', () => {
    const { ir, stderr } = compileGen(GEN('cron :market_hours'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/unknown cron name :market_hours/)
  })

  it('rejects cron :hourly with at: (hourly takes no anchor time)', () => {
    const { ir, stderr } = compileGen(GEN('cron :hourly, at: "9:00"'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/does not accept `at:`/)
  })
})

describe('cron primitive — raw crontab', () => {
  it('accepts a valid 5-field crontab', () => {
    const { ir, stderr } = compileGen(GEN('cron "30 9 * * 1-5"'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules?.[0]).toMatchObject({
      expression: '30 9 * * 1-5',
    })
    // Slug is a hash prefix.
    expect(ir!.policies.schedules[0].id).toMatch(/^g\.analyze\.cron_[0-9a-f]{4}$/)
  })

  it('rejects a 4-field expression', () => {
    const { ir, stderr } = compileGen(GEN('cron "30 9 * *"'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/must have exactly 5 fields/)
  })

  it('rejects invalid characters in a field', () => {
    const { ir, stderr } = compileGen(GEN('cron "30 9 * * mon"'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/invalid characters in cron field/)
  })

  it('rejects `at:` with raw crontab', () => {
    const { ir, stderr } = compileGen(GEN('cron "30 9 * * *", at: "9:00"'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/`at:` kwarg not valid with a raw crontab/)
  })
})

describe('cron primitive — kwargs', () => {
  it('id: overrides the slug', () => {
    const { ir, stderr } = compileGen(GEN('cron :daily, at: "9:00", id: :morning'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules?.[0].id).toBe('g.analyze.morning')
  })

  it('tz: captures the time zone', () => {
    const { ir, stderr } = compileGen(GEN('cron :daily, at: "9:00", tz: "America/New_York"'))
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules?.[0].tz).toBe('America/New_York')
  })

  it('tz: defaults to UTC when omitted', () => {
    const { ir } = compileGen(GEN('cron :daily'))
    expect(ir?.policies?.schedules?.[0].tz).toBe('UTC')
  })

  it('rejects an invalid id:', () => {
    const { ir, stderr } = compileGen(GEN('cron :daily, id: :BadId'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/id: must match/)
  })

  it('rejects an unknown kwarg', () => {
    const { ir, stderr } = compileGen(GEN('cron :daily, foobar: true'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/unknown option\(s\)/)
  })
})

describe('cron primitive — multi-schedule + method resolution', () => {
  it('accumulates multiple cron declarations', () => {
    const { ir } = compileGen(GEN('cron :daily, at: "9:00", id: :morning\n  cron :daily, at: "18:00", id: :evening'))
    expect(ir?.policies?.schedules).toHaveLength(2)
    const ids = ir!.policies.schedules.map((s: any) => s.id).sort()
    expect(ids).toEqual(['g.analyze.evening', 'g.analyze.morning'])
  })

  it('defaults method to the single user-defined method when absent', () => {
    const { ir } = compileGen(GEN('cron :daily'))
    expect(ir?.policies?.schedules?.[0].method).toBe('analyze')
  })

  it('requires explicit method: when the gen declares multiple methods', () => {
    const gen = `
class G < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  cron :daily

  def analyze(input); generate("go") { with context: input; returns AnalysisReport }; end
  def other(input);   generate("go") { with context: input; returns AnalysisReport }; end
end
`
    const { ir, stderr } = compileGen(gen)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/requires explicit `method:`/)
  })

  it('detects duplicate ID within a class', () => {
    const gen = GEN('cron :daily\n  cron :daily, id: :daily')
    const { ir, stderr } = compileGen(gen)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/duplicate/i)
  })
})

describe('cron primitive — memory :schedule scope pairing', () => {
  it('memory scope: :schedule requires at least one cron', () => {
    const gen = `
class G < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, scope: :schedule, strategy: :sliding_window, size: 1

  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`
    const { ir, stderr } = compileGen(gen)
    expect(ir).toBeNull()
    expect(stderr).toMatch(/scope: :schedule.*no `cron` declarations/)
  })

  it('memory scope: :schedule + cron works', () => {
    const gen = `
class G < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  cron :daily
  memory :x, scope: :schedule, strategy: :sliding_window, size: 1

  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`
    const { ir, stderr } = compileGen(gen)
    expect(stderr).toBe('')
    expect(ir?.policies?.schedules).toHaveLength(1)
    expect(ir?.policies?.memory?.[0]?.scope).toBe('schedule')
  })
})

describe('cron primitive — IR absence', () => {
  it('gen with no cron declaration emits empty policies.schedules', () => {
    const { ir } = compileGen(GEN('# no cron'))
    expect(ir?.policies?.schedules).toEqual([])
  })
})
