import { describe, it, expect } from 'vitest'
import { ToolRegistry } from './registry.js'
import { join } from 'node:path'

const BUILTINS = join(process.cwd(), 'packages/cambium-runner/src/builtin-tools')
const APP_TOOLS = join(process.cwd(), 'packages/cambium/app/tools')

describe('ToolRegistry', () => {
  it('loads tool definitions from directory', async () => {
    const reg = new ToolRegistry()
    await reg.loadFromDir(BUILTINS)
    expect(reg.list()).toContain('calculator')
  })

  it('returns undefined for unknown tool', () => {
    const reg = new ToolRegistry()
    expect(reg.get('nonexistent')).toBeUndefined()
  })

  it('gets a loaded tool definition', async () => {
    const reg = new ToolRegistry()
    await reg.loadFromDir(BUILTINS)
    const def = reg.get('calculator')
    expect(def).toBeDefined()
    expect(def!.name).toBe('calculator')
    expect(def!.inputSchema).toBeDefined()
    expect(def!.outputSchema).toBeDefined()
  })

  it('assertAllowed passes for allowed tools', async () => {
    const reg = new ToolRegistry()
    await reg.loadFromDir(BUILTINS)
    expect(() => reg.assertAllowed('calculator', ['calculator'])).not.toThrow()
  })

  it('assertAllowed throws for disallowed tools', () => {
    const reg = new ToolRegistry()
    expect(() => reg.assertAllowed('calculator', [])).toThrow('not in policies.tools_allowed')
  })

  it('handles missing directory gracefully', async () => {
    const reg = new ToolRegistry()
    await reg.loadFromDir('/nonexistent/path')
    expect(reg.list()).toEqual([])
  })

  it('auto-discovers plugin tool handlers alongside schemas (RED-209)', async () => {
    // The `echo_plugin` fixture lives in packages/cambium/app/tools/ as a
    // paired .tool.json + .tool.ts. The registry should load both.
    const reg = new ToolRegistry()
    await reg.loadFromDir(APP_TOOLS)
    const handler = reg.getHandler('echo_plugin')
    expect(handler).toBeDefined()
    const out = await handler!({ message: 'hi' })
    expect(out).toEqual({ echoed: 'hi' })
  })

  it('a later loadFromDir overrides an earlier one on name collision (RED-221 override hook)', async () => {
    // Post-RED-221 the runner loads builtin-tools first, then app-tools.
    // A .tool.json in app-tools with the same name as a framework builtin
    // wins. Exercise that: load builtins, then a temp dir whose calculator
    // schema has a marker we can check for.
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const override = mkdtempSync(join(tmpdir(), 'cambium-override-'))
    writeFileSync(join(override, 'calculator.tool.json'), JSON.stringify({
      name: 'calculator',
      description: 'OVERRIDE MARKER',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
    }))

    const reg = new ToolRegistry()
    await reg.loadFromDir(BUILTINS)
    expect(reg.get('calculator')!.description).not.toBe('OVERRIDE MARKER')
    await reg.loadFromDir(override)
    expect(reg.get('calculator')!.description).toBe('OVERRIDE MARKER')
  })
})
