import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.ATELIER_TEST_USERDATA as string }
}))

import {
  buildContextBlock,
  buildContextMcpServers,
  buildSystemInstruction,
  contextStorageKey,
  guideStorageKey,
  pluginValueOrDefault
} from './contextTools.js'
import { pluginStorageSet } from './pluginStorage.js'
import type { PluginRegistry } from './PluginRegistry.js'
import type { ConversationPluginState } from '../shared/plugins.js'

let userData: string

type Exports = {
  key: string
  label: string
  format: string
  maxTokens: number
  inject?: boolean
}[]
function fakeRegistry(byId: Record<string, Exports>): PluginRegistry {
  return {
    get: (id: string) => (byId[id] ? { manifest: { contextExports: byId[id] } } : undefined)
  } as unknown as PluginRegistry
}
const pinned = (keys: string[]): ConversationPluginState => ({ enabled: true, pinnedExports: keys })

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'atelier-ctx-'))
  process.env.ATELIER_TEST_USERDATA = userData
})
afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
  delete process.env.ATELIER_TEST_USERDATA
})

const REG = fakeRegistry({
  mm: [{ key: 'model', label: 'Mental model', format: 'markdown', maxTokens: 1000 }]
})

describe('buildContextBlock', () => {
  it('is empty when nothing is pinned', () => {
    expect(buildContextBlock(REG, 'c1', {})).toBe('')
  })

  it('includes a pinned, enabled, non-empty export', () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'A house has 3 rooms')
    const block = buildContextBlock(REG, 'c1', { mm: pinned(['model']) })
    expect(block).toContain('<atelier-context>')
    expect(block).toContain('## Mental model')
    expect(block).toContain('A house has 3 rooms')
  })

  it('skips disabled, unpinned, and empty exports', () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'X')
    expect(buildContextBlock(REG, 'c1', { mm: { enabled: false, pinnedExports: ['model'] } })).toBe(
      ''
    )
    expect(buildContextBlock(REG, 'c1', { mm: pinned([]) })).toBe('')
    expect(buildContextBlock(REG, 'c2', { mm: pinned(['model']) })).toBe('') // other conversation
  })

  it('truncates a value beyond maxTokens', () => {
    pluginStorageSet('c1', 'big', contextStorageKey('model'), 'x'.repeat(100))
    const reg = fakeRegistry({
      big: [{ key: 'model', label: 'M', format: 'text', maxTokens: 10 }] // cap ~40 chars
    })
    expect(buildContextBlock(reg, 'c1', { big: pinned(['model']) })).toContain('…[truncated]')
  })

  it('injects the author guide alongside the value, framed read-only', () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'A house has 3 rooms')
    pluginStorageSet('c1', 'mm', guideStorageKey('model'), 'Keep this under 5 bullet points.')
    const block = buildContextBlock(REG, 'c1', { mm: pinned(['model']) })
    expect(block).toContain('Keep this under 5 bullet points.')
    expect(block).toContain('do not edit')
    expect(block).toContain('A house has 3 rooms')
  })

  it('injects a guide even when the value is empty', () => {
    pluginStorageSet('c1', 'mm', guideStorageKey('model'), 'Author note with no doc yet.')
    const block = buildContextBlock(REG, 'c1', { mm: pinned(['model']) })
    expect(block).toContain('Author note with no doc yet.')
  })
})

describe('buildContextMcpServers', () => {
  it('is undefined when nothing is pinned', () => {
    expect(buildContextMcpServers(REG, 'c1', {}, () => {})).toBeUndefined()
  })

  it('builds an sdk server when an export is pinned', () => {
    const servers = buildContextMcpServers(REG, 'c1', { mm: pinned(['model']) }, () => {})
    expect(servers?.atelier_context).toBeDefined()
    expect(servers?.atelier_context.type).toBe('sdk')
  })

  it('the set_ tool persists the value and fires onChange (the push trigger)', async () => {
    const changes: { pluginId: string; key: string }[] = []
    const servers = buildContextMcpServers(REG, 'c1', { mm: pinned(['model']) }, (pluginId, key) =>
      changes.push({ pluginId, key })
    )
    // Invoke the registered tool's callback the way the agent would (reaches into the MCP
    // SDK's McpServer internals — brittle by design, so an SDK upgrade fails loudly here).
    const reg = (servers!.atelier_context.instance as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { handler: (a: { content: string }) => Promise<unknown> }>
    const entry = reg['set_mm__model']
    expect(entry).toBeDefined()
    await entry.handler({ content: 'new model text' })
    // Value landed in storage …
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe('new model text')
    // … and onChange fired with the routing keys main.ts forwards as context:changed.
    expect(changes).toEqual([{ pluginId: 'mm', key: 'model' }])
  })
})

describe('the edit_ tool (targeted find-and-replace)', () => {
  type EditArgs = { old_string: string; new_string: string; replace_all?: boolean }
  type EditResult = { content: { text: string }[]; isError?: boolean }
  type ToolEntry = { handler: (a: EditArgs) => Promise<EditResult> }

  function editTool(conversationId: string, onChange: (p: string, k: string) => void = () => {}) {
    const servers = buildContextMcpServers(REG, conversationId, { mm: pinned(['model']) }, onChange)
    const reg = (servers!.atelier_context.instance as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, ToolEntry>
    return reg['edit_mm__model']
  }

  it('is registered alongside set_ for every pinned export', () => {
    const servers = buildContextMcpServers(REG, 'c1', { mm: pinned(['model']) }, () => {})
    const reg = (servers!.atelier_context.instance as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, unknown>
    expect(reg['set_mm__model']).toBeDefined()
    expect(reg['edit_mm__model']).toBeDefined()
  })

  it('replaces a unique occurrence, persists, and fires onChange', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'A house has 3 rooms and 1 door')
    const changes: { pluginId: string; key: string }[] = []
    const t = editTool('c1', (pluginId, key) => changes.push({ pluginId, key }))
    const res = await t.handler({ old_string: '3 rooms', new_string: '4 rooms' })
    expect(res.isError).toBeFalsy()
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe(
      'A house has 4 rooms and 1 door'
    )
    expect(changes).toEqual([{ pluginId: 'mm', key: 'model' }])
  })

  it('errors (without writing) when old_string is not unique and replace_all is unset', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'red red red')
    const changes: unknown[] = []
    const t = editTool('c1', () => changes.push(1))
    const res = await t.handler({ old_string: 'red', new_string: 'blue' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('not unique')
    // storage untouched, no push fired
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe('red red red')
    expect(changes).toEqual([])
  })

  it('replaces every occurrence with replace_all', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'red red red')
    const res = await editTool('c1').handler({
      old_string: 'red',
      new_string: 'blue',
      replace_all: true
    })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('3 replacements')
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe('blue blue blue')
  })

  it('errors when old_string is not found', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'the map is not the territory')
    const res = await editTool('c1').handler({ old_string: 'nowhere', new_string: 'x' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('not found')
  })

  it('errors on an empty value and points at set_', async () => {
    const res = await editTool('c1').handler({ old_string: 'a', new_string: 'b' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('set_mm__model')
  })

  it('treats `$` in new_string literally (no String.replace pattern interpretation)', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'cost is TOKEN here')
    const res = await editTool('c1').handler({ old_string: 'TOKEN', new_string: '$1 & $&' })
    expect(res.isError).toBeFalsy()
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe(
      'cost is $1 & $& here'
    )
  })
})

describe('push-only exports (inject:false)', () => {
  const PUSH = fakeRegistry({
    viz: [
      { key: 'architecture', label: 'Architecture', format: 'json', maxTokens: 8000, inject: false }
    ]
  })
  it('registers the write-tool but never injects the value', () => {
    pluginStorageSet('c1', 'viz', contextStorageKey('architecture'), '{"nodes":[]}')
    // value is NOT fed back into the per-turn context block …
    expect(buildContextBlock(PUSH, 'c1', { viz: pinned(['architecture']) })).toBe('')
    // … but the agent still gets its set_ write-tool
    const servers = buildContextMcpServers(PUSH, 'c1', { viz: pinned(['architecture']) }, () => {})
    expect(servers?.atelier_context).toBeDefined()
  })
})

describe('buildSystemInstruction', () => {
  // A registry whose `instr` plugin declares a systemInstruction sourced from ctx:instruction.
  const SI = {
    get: (id: string) =>
      id === 'instr'
        ? { manifest: { systemInstruction: { key: 'instruction', maxTokens: 1000 } } }
        : undefined
  } as unknown as PluginRegistry
  const on = (): ConversationPluginState => ({ enabled: true, pinnedExports: [] })

  it('is empty when no enabled plugin contributes one', () => {
    expect(buildSystemInstruction(SI, 'c1', {})).toBe('')
  })

  it('returns the stored instruction for an enabled plugin', () => {
    pluginStorageSet('c1', 'instr', contextStorageKey('instruction'), 'This project is Go.')
    expect(buildSystemInstruction(SI, 'c1', { instr: on() })).toBe('This project is Go.')
  })

  it('skips disabled plugins, empty values, and other conversations', () => {
    pluginStorageSet('c1', 'instr', contextStorageKey('instruction'), 'X')
    expect(buildSystemInstruction(SI, 'c1', { instr: { enabled: false, pinnedExports: [] } })).toBe(
      ''
    )
    pluginStorageSet('c2', 'instr', contextStorageKey('instruction'), '   ')
    expect(buildSystemInstruction(SI, 'c2', { instr: on() })).toBe('')
    expect(buildSystemInstruction(SI, 'c3', { instr: on() })).toBe('') // no value for c3
  })

  it('truncates past the cap', () => {
    const big = {
      get: () => ({ manifest: { systemInstruction: { key: 'instruction', maxTokens: 10 } } }) // ~40 chars
    } as unknown as PluginRegistry
    pluginStorageSet('c1', 'instr', contextStorageKey('instruction'), 'x'.repeat(200))
    expect(buildSystemInstruction(big, 'c1', { instr: on() })).toContain('…[truncated]')
  })
})

describe('pluginValueOrDefault', () => {
  const dirRegistry = (id: string, dir: string): PluginRegistry =>
    ({ get: (x: string) => (x === id ? { dir } : undefined) }) as unknown as PluginRegistry

  it('uses the packaged default only until the key is written; respects an explicit clear', () => {
    const dir = join(userData, 'plug')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'defaults.json'),
      JSON.stringify({ 'ctx:instruction': 'DEFAULT', 'guide:model': 'GUIDE' })
    )
    const reg = dirRegistry('p', dir)
    // Never written → packaged default.
    expect(pluginValueOrDefault(reg, 'cX', 'p', contextStorageKey('instruction'))).toBe('DEFAULT')
    expect(pluginValueOrDefault(reg, 'cX', 'p', guideStorageKey('model'))).toBe('GUIDE')
    // Key absent from defaults → null (no default to apply).
    expect(pluginValueOrDefault(reg, 'cX', 'p', contextStorageKey('nope'))).toBe(null)
    // A written value wins over the default.
    pluginStorageSet('cX', 'p', contextStorageKey('instruction'), 'MINE')
    expect(pluginValueOrDefault(reg, 'cX', 'p', contextStorageKey('instruction'))).toBe('MINE')
    // An explicit empty string is respected — it does NOT snap back to the default.
    pluginStorageSet('cX', 'p', guideStorageKey('model'), '')
    expect(pluginValueOrDefault(reg, 'cX', 'p', guideStorageKey('model'))).toBe('')
  })
})
