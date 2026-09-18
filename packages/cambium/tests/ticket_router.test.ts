/**
 * TicketRouter — golden regression test (RED-140).
 *
 * Workflow (token-free after the first run):
 *
 *   1. Create a fixture: packages/cambium/examples/fixtures/<fixture>.txt
 *   2. Run once to produce a snapshot:
 *        cambium run packages/cambium/app/gens/ticket_router.cmb.rb --method route \
 *          --arg packages/cambium/examples/fixtures/<fixture>.txt --mock
 *      Copy the output from the run dir (runs/<id>/output.json) to
 *        packages/cambium/examples/fixtures/ticket_router-snapshot.json
 *      Commit both files.
 *   3. After that, `npm test` (--mock path) never burns tokens.
 *      Replay an old run instead of re-calling the LLM:
 *        cambium replay <run-id> --mock
 *
 * Edit the snapshot file when the expected output legitimately changes;
 * the test failure is the signal.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { goldenTest, normalizeStrings } from '../../cambium-runner/src/golden.js'

const REPO_ROOT = process.cwd()
// #282: this file lives at <appPkgRoot>/tests/<name>.test.ts, so the app
// package root is two levels up. Deriving it from the file's own URL keeps
// the test runnable from any checkout; #199 DEC-009 baked the scaffolding
// machine's absolute appPkgRoot in as a literal, which passes only there.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// How to invoke the CLI from this workspace. In-tree Cambium repo: run the CLI entrypoint directly.
const CAMBIUM: string[] = ['node', join(REPO_ROOT, 'cli/cambium.mjs')]
// GEN/FIXTURE below are emitted via JSON.stringify, never raw
// string splicing (#199 DEC-012) — genRel and fixtureRel both ultimately
// trace back to untrusted run-directory input (entry.source, a promoted
// context value's derived path), and a quote or backtick in either would
// otherwise close the literal early and splice live statements into this
// file. JSON.stringify's output is a valid ECMAScript string literal for
// any string content (Node >= ES2019), so this is safe for arbitrary text.
const GEN = join(PKG_ROOT, "app/gens/ticket_router.cmb.rb")
const FIXTURE = join(PKG_ROOT, "examples/fixtures/ticket_router_request.txt")
const SNAPSHOT = join(PKG_ROOT, "examples/fixtures/ticket_router-snapshot.json")

function runMock() {
  const [bin, ...pre] = CAMBIUM
  return spawnSync(
    bin,
    [...pre, 'run', GEN, '--method', 'route', '--arg', FIXTURE, '--mock'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
}

// Derive the run directory from the "Trace: <path>" line that `cambium run`
// writes to stderr. This is the documented, user-facing CLI output
// (cambium.mjs: console.error(`Trace: ${result.tracePath}`)); taking
// dirname() of the trace path gives the run dir without parsing internal
// diagnostic lines whose format may change.
function runDirFromStderr(stderr: string): string | null {
  const m = stderr.match(/Trace: (\S+)/)
  return m ? dirname(m[1]) : null
}

describe('TicketRouter', () => {
  it('compiles to valid IR', () => {
    // Compile via the CLI rather than spawning ruby against a
    // `ruby/cambium/compile.rb` path: only the Cambium repo itself has
    // that directory. The CLI resolves the compiler relative to its own
    // install (RED-274), so this works in any workspace.
    const irOut = join(tmpdir(), `ticket_router-${process.pid}.ir.json`)
    const [bin, ...pre] = CAMBIUM
    const result = spawnSync(
      bin,
      [...pre, 'compile', GEN, '--method', 'route', '-o', irOut],
      { encoding: 'utf8', cwd: REPO_ROOT },
    )
    expect(result.status, `Compile failed:\n${result.stderr}`).toBe(0)
    const ir = JSON.parse(readFileSync(irOut, 'utf8'))
    try { rmSync(irOut, { force: true }) } catch {}
    expect(ir.entry.class).toBe('TicketRouter')
    expect(ir.entry.method).toBe('route')
  })

  it('produces output matching the golden snapshot (mock, token-free)', () => {
    if (!existsSync(FIXTURE)) {
      // Fixture not yet created — skip rather than fail.
      // Create examples/fixtures/<fixture>.txt and re-run.
      console.warn('[TicketRouter] fixture not found — skipping golden test')
      return
    }
    if (!existsSync(SNAPSHOT)) {
      // No snapshot yet. Run once, copy output.json → snapshot, commit.
      console.warn('[TicketRouter] snapshot not found — run once with --mock and commit output.json as ticket_router-snapshot.json')
      return
    }

    const result = runMock()
    expect(result.status, `Gen failed:\n${result.stderr}`).toBe(0)

    // `cambium run` writes the output JSON to stdout (its primary output
    // channel). Parsing stdout is more robust than reading output.json from
    // the run dir, because it does not depend on the internal artifact layout.
    const actual = JSON.parse(result.stdout)
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))

    // normalizeStrings trims and collapses whitespace — the mock generator
    // can vary in spacing. Add more normalizers (normalizeDates, normalizeNumbers)
    // or ignoreFields as your schema needs.
    const { passed, summary } = goldenTest(actual, expected, {
      normalizers: [normalizeStrings],
    })
    expect(passed, summary).toBe(true)

    // Clean up the run dir so the test suite stays idempotent.
    const runDir = runDirFromStderr(result.stderr)
    if (runDir) try { rmSync(runDir, { recursive: true, force: true }) } catch {}
  })
})
