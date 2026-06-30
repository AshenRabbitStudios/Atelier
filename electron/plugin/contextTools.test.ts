import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
  guideStorageKey
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
