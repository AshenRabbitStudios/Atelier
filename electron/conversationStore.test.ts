import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The store reads its root from Electron's `app.getPath('userData')`. Stub Electron with
// a temp dir so persistence can be exercised in plain Node.
vi.mock('electron', () => ({
  app: { getPath: () => process.env.ATELIER_TEST_USERDATA as string }
}))

import {
  saveConversation,
  listConversations,
  getActiveConversationId,
  setActiveConversationId,
  getOpenConversationIds,
  setOpenConversationIds,
  deleteConversationData,
  type ConversationManifest
} from './conversationStore.js'

let userData: string

function manifest(id: string, createdAt: number): ConversationManifest {
  return {
    id,
    title: `conv ${id}`,
    cwd: `/work/${id}`,
    branches: [{ sessionId: `${id}-main`, label: 'main', createdAt }],
    activeBranch: `${id}-main`,
    createdAt,
    updatedAt: createdAt
  }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'atelier-conv-'))
  process.env.ATELIER_TEST_USERDATA = userData
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
  delete process.env.ATELIER_TEST_USERDATA
})

describe('conversation persistence', () => {
  it('returns [] before anything is saved', () => {
    expect(listConversations()).toEqual([])
  })

  it('round-trips a saved manifest', () => {
    saveConversation(manifest('a', 1000))
    const all = listConversations()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: 'a', title: 'conv a', cwd: '/work/a' })
  })

  it('lists conversations sorted by createdAt', () => {
    saveConversation(manifest('late', 3000))
    saveConversation(manifest('early', 1000))
    saveConversation(manifest('mid', 2000))
    expect(listConversations().map((m) => m.id)).toEqual(['early', 'mid', 'late'])
  })

  it('deleteConversationData removes a conversation', () => {
    saveConversation(manifest('a', 1000))
    saveConversation(manifest('b', 2000))
    deleteConversationData('a')
    expect(listConversations().map((m) => m.id)).toEqual(['b'])
  })
})

describe('app state', () => {
  it('defaults to null active id and empty open set', () => {
    expect(getActiveConversationId()).toBeNull()
    expect(getOpenConversationIds()).toEqual([])
  })

  it('persists active id and open set independently', () => {
    setActiveConversationId('a')
    setOpenConversationIds(['a', 'b'])
    expect(getActiveConversationId()).toBe('a')
    expect(getOpenConversationIds()).toEqual(['a', 'b'])
    // Updating one field must not clobber the other.
    setActiveConversationId('b')
    expect(getOpenConversationIds()).toEqual(['a', 'b'])
  })
})
