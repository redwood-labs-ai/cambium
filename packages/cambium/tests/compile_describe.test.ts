import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * #196: `describe` — a class-level, machine-readable statement of what a
 * gen does, read by a self-description surface (`/v1/gens`, MCP
 * `tools/list`) instead of the gen's source.
 *
 * Tests shell out to the Ruby compiler and assert on IR shape, exactly
 * like the sibling compile_*.test.ts files.
 *
 * Two properties here are load-bearing beyond "the field round-trips",
 * and each has its own case below:
 *
 *  - Absent-when-undeclared. `compile.rb` emits the key only when the
 *    gen declared one (`defs[:description] ? { ... } : {}`). If that ever
 *    becomes an unconditional `'description' => defs[:description]`, every
 *    existing gen gains a `"description": null` and stops compiling to the
 *    bytes it did before this primitive existed — the additivity claim in
 *    CHANGELOG and COMPATIBILITY. The golden corpus catches this too, but
 *    only as an opaque snapshot diff; this pins the actual rule.
 *
 *  - Metadata only. `describe` must never reach prompt assembly. That is
 *    a claim about where the text does NOT appear, so it is asserted that
 *    way — with a sentinel that would be trivially greppable if it leaked
 *    into the system prompt or anywhere else in the IR.
 */

const COMPILE = 'ruby/cambium/compile.rb'

function compile(genPath: string, method = 'analyze'): any {
  const stdout = execSync(`ruby ${COMPILE} ${genPath} --method ${method}`, {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
  return JSON.parse(stdout)
}

function writeGen(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-196-'))
  const path = join(dir, 'described.cmb.rb')
  writeFileSync(path, body.trim() + '\n')
  return path
}

const DECLARED = 'Extracts a 26-key semantic palette from wallpaper swatches'

function gen(describeLine: string, returnsBlock = 'field :ok, Boolean'): string {
  return `
class Described < Cambium::GenModel
${describeLine}
  model "omlx:test"
  system "You are a probe."
  returns do
    ${returnsBlock}
  end
  def analyze(ctx); end
end
`
}

describe('#196: describe — machine-readable gen description', () => {
  it('emits the declared text as a top-level IR `description`', () => {
    const ir = compile(writeGen(gen(`  describe "${DECLARED}"`)))
    expect(ir.description).toBe(DECLARED)
  })

  it('omits the key entirely when undeclared — not null, not empty string', () => {
    const ir = compile(writeGen(gen('')))
    // `toBeUndefined()` would also pass on an explicit `"description": null`,
    // which is precisely the regression this case exists to catch.
    expect(Object.prototype.hasOwnProperty.call(ir, 'description')).toBe(false)
  })

  it('is distinct from the per-field `description:` nested under returnSchema', () => {
    const ir = compile(
      writeGen(gen(`  describe "${DECLARED}"`, 'field :ok, Boolean, description: "Whether the probe succeeded"')),
    )
    expect(ir.description).toBe(DECLARED)
    expect(ir.returnSchema.properties.ok.description).toBe('Whether the probe succeeded')
  })

  it('carries a per-field `description:` without inventing a top-level one', () => {
    const ir = compile(writeGen(gen('', 'field :ok, Boolean, description: "Whether the probe succeeded"')))
    expect(ir.returnSchema.properties.ok.description).toBe('Whether the probe succeeded')
    expect(Object.prototype.hasOwnProperty.call(ir, 'description')).toBe(false)
  })

  it('is metadata only — the text never reaches the assembled system prompt', () => {
    const sentinel = 'SENTINEL_DESCRIBE_MUST_NOT_REACH_THE_PROMPT'
    const ir = compile(writeGen(gen(`  describe "${sentinel}"`)))

    expect(ir.description).toBe(sentinel)
    expect(ir.system).not.toContain(sentinel)

    // Nowhere else in the IR either: strip the one key that is allowed to
    // hold it and the sentinel should be gone from the whole document.
    const { description, ...rest } = ir
    expect(JSON.stringify(rest)).not.toContain(sentinel)
  })
})
