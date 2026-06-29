import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.ATELIER_TEST_USERDATA as string }
}))

import { buildContextBlock, buildContextMcpServers, contextStorageKey } from './contextTools.js'
import { pluginStorageSet } from './pluginStorage.js'
import type { PluginRegistry } from './PluginRegistry.js'
import type { ConversationPluginState } from '../shared/plugins.js'

let userData: string

type Exports = { key: string; label: string; format: string; maxTokens: number }[]
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
