import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * RED-212 end-to-end: compile a gen that declares a custom action
 * inside an `on :signal do ... end` trigger, run it with --mock, and
 * assert the action fired through the spawned-CLI path.
 */

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt'

function writeGen(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red212-'))
  const path = join(dir, 'trigger_action.cmb.rb')
  writeFileSync(path, body.trim())
  return path
}

function runCli(genPath: string): {
  status: number | null
  stderr: string
  stdout: string
  tracePath: string
  outPath: string
} {
  const runDir = mkdtempSync(join(tmpdir(), 'cambium-red212-run-'))
  const tracePath = join(runDir, 'trace.json')
  const outPath = join(runDir, 'output.json')
  const result = spawnSync(
    'node',
    ['cli/cambium.mjs', 'run', genPath,
      '--method', 'analyze', '--arg', FIXTURE_ARG,
      '--trace', tracePath, '--out', outPath, '--mock'],
    {
      encoding: 'utf8',
      env: { ...process.env, CAMBIUM_ALLOW_MOCK: '1' },
      cwd: process.cwd(),
    },
  )
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
    tracePath,
    outPath,
  }
}

describe('trigger actions end-to-end (RED-212)', () => {
  it('compiles + runs a gen whose trigger invokes notify_stderr', () => {
    const gen = writeGen(`
class ActionTriggerGen < GenModel
  model :default
  system :analyst
  returns AnalysisReport

  extract :latency_ms, type: :number, path: "metrics.latency_ms_samples"

  on :latency_ms do
    action :notify_stderr, prefix: "[TRIGGER]", message: "latency signal fired"
  end

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`)

    const run = runCli(gen)
    expect([0, 1]).toContain(run.status)

    // stderr should carry the notify_stderr output line.
    expect(run.stderr).toMatch(/\[TRIGGER\] latency signal fired/)

    // The trace should record an ActionCall step.
    const trace = JSON.parse(readFileSync(run.tracePath, 'utf8'))
    const actionCall = trace.steps.find((s: any) => s.type === 'ActionCall')
    expect(actionCall).toBeDefined()
    expect(actionCall.ok).toBe(true)
    expect(actionCall.meta.action).toBe('notify_stderr')
    expect(actionCall.meta.trigger).toBe('latency_ms')
  }, 60_000)

  it('fails fast at runner startup when a trigger references an unknown action', () => {
    const gen = writeGen(`
class BadActionGen < GenModel
  model :default
  system :analyst
  returns AnalysisReport

  extract :latency_ms, type: :number, path: "metrics.latency_ms_samples"

  on :latency_ms do
    action :does_not_exist, foo: "bar"
  end

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`)
    const run = runCli(gen)
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/Trigger action "does_not_exist" not found/)
  }, 60_000)

  it('tool_call triggers still work unchanged after the action_call path was added', () => {
    // Regression guard — existing behaviour must not drift. The analyst
    // in-tree gen has a `tool :calculator, operation: :avg` trigger that
    // writes into metrics.avg_latency_ms. Compile + run the real thing.
    const run = runCli('packages/cambium/app/gens/analyst.cmb.rb')
    expect([0, 1]).toContain(run.status)

    const trace = JSON.parse(readFileSync(run.tracePath, 'utf8'))
    const toolCalls = trace.steps.filter((s: any) => s.type === 'ToolCall')
    // The analyst's trigger fires calculator exactly once (avg of samples).
    expect(toolCalls.length).toBeGreaterThan(0)
  }, 60_000)
})
