import { describe, it, expect } from 'vitest'
import { ToolRegistry } from './registry.js'
import { join } from 'node:path'

describe('ToolRegistry', () => {
  it('loads tool definitions from directory', async () => {
    const reg = new ToolRegistry()
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
    expect(reg.list()).toContain('calculator')
  })

  it('returns undefined for unknown tool', () => {
    const reg = new ToolRegistry()
    expect(reg.get('nonexistent')).toBeUndefined()
  })

  it('gets a loaded tool definition', async () => {
    const reg = new ToolRegistry()
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
    const def = reg.get('calculator')
    expect(def).toBeDefined()
    expect(def!.name).toBe('calculator')
    expect(def!.inputSchema).toBeDefined()
    expect(def!.outputSchema).toBeDefined()
  })

  it('assertAllowed passes for allowed tools', async () => {
    const reg = new ToolRegistry()
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
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
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
    const handler = reg.getHandler('echo_plugin')
    expect(handler).toBeDefined()
    const out = await handler!({ message: 'hi' })
    expect(out).toEqual({ echoed: 'hi' })
  })
})
