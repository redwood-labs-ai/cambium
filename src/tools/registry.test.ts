import { describe, it, expect } from 'vitest'
import { ToolRegistry } from './registry.js'
import { join } from 'node:path'

describe('ToolRegistry', () => {
  it('loads tool definitions from directory', () => {
    const reg = new ToolRegistry()
    reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
    expect(reg.list()).toContain('calculator')
  })

  it('returns undefined for unknown tool', () => {
    const reg = new ToolRegistry()
    expect(reg.get('nonexistent')).toBeUndefined()
  })

  it('gets a loaded tool definition', () => {
    const reg = new ToolRegistry()
    reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
    const def = reg.get('calculator')
    expect(def).toBeDefined()
    expect(def!.name).toBe('calculator')
    expect(def!.inputSchema).toBeDefined()
    expect(def!.outputSchema).toBeDefined()
  })

  it('assertAllowed passes for allowed tools', () => {
    const reg = new ToolRegistry()
    reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
    expect(() => reg.assertAllowed('calculator', ['calculator'])).not.toThrow()
  })

  it('assertAllowed throws for disallowed tools', () => {
    const reg = new ToolRegistry()
    expect(() => reg.assertAllowed('calculator', [])).toThrow('not in policies.tools_allowed')
  })

  it('handles missing directory gracefully', () => {
    const reg = new ToolRegistry()
    reg.loadFromDir('/nonexistent/path')
    expect(reg.list()).toEqual([])
  })
})
