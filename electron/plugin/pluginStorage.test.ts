import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Stub Electron's userData path with a temp dir (same pattern as conversationStore.test.ts).
vi.mock('electron', () => ({
  app: { getPath: () => process.env.ATELIER_TEST_USERDATA as string }
}))

import { pluginStorageGet, pluginStorageSet, pluginStorageKeys } from './pluginStorage.js'

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'atelier-pstore-'))
  process.env.ATELIER_TEST_USERDATA = userData
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
  delete process.env.ATELIER_TEST_USERDATA
})

describe('plugin storage', () => {
  it('returns null for an unset key', () => {
    expect(pluginStorageGet('c1', 'p1', 'k')).toBeNull()
  })

  it('round-trips values and lists keys', () => {
    pluginStorageSet('c1', 'p1', 'note', 'hello')
    pluginStorageSet('c1', 'p1', 'count', 42)
    expect(pluginStorageGet('c1', 'p1', 'note')).toBe('hello')
    expect(pluginStorageGet('c1', 'p1', 'count')).toBe(42)
    expect(pluginStorageKeys('c1', 'p1').sort()).toEqual(['count', 'note'])
  })

  it('isolates storage by (conversation, plugin)', () => {
    pluginStorageSet('c1', 'p1', 'k', 'A')
    expect(pluginStorageGet('c2', 'p1', 'k')).toBeNull() // different conversation
    expect(pluginStorageGet('c1', 'p2', 'k')).toBeNull() // different plugin
    expect(pluginStorageGet('c1', 'p1', 'k')).toBe('A')
  })
})
