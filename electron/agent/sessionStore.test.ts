import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the store's `~/.claude/projects` lookup at a throwaway temp home. We keep the
// rest of `node:os` real (so `tmpdir()` above still works) and override only homedir,
// reading it from an env var so there's no hoisting hazard in the mock factory.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => process.env.ATELIER_TEST_HOME as string }
})

import { readTranscript, editMessageText, parentUuidOf, childUuidOf } from './sessionStore.js'

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

let home: string
let sessionId: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atelier-sess-'))
  process.env.ATELIER_TEST_HOME = home
  // Unique id per test so the module-level file cache never collides across tests.
  sessionId = `sess-${Math.random().toString(36).slice(2)}`
  const dir = join(home, '.claude', 'projects', 'some-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    jsonl([
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'hi there' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'x' } }
          ]
        }
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false }
          ]
        }
      },
      // Sidechains are attachments, not real turns — must be skipped.
      { type: 'user', uuid: 's1', isSidechain: true, message: { role: 'user', content: 'side' } }
    ]),
    'utf8'
  )
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.ATELIER_TEST_HOME
})

describe('readTranscript', () => {
  it('returns only real user/assistant turns and folds tool_result onto its tool_use', () => {
    const t = readTranscript(sessionId)
    expect(t).toHaveLength(2) // tool_result and sidechain do not add messages

    expect(t[0]).toMatchObject({ uuid: 'u1', role: 'user' })
    expect(t[0].blocks[0]).toEqual({ kind: 'text', text: 'hello' })

    const a = t[1]
    expect(a).toMatchObject({ uuid: 'a1', role: 'assistant' })
    expect(a.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool_use'])

    const toolUse = a.blocks[2]
    expect(toolUse.kind).toBe('tool_use')
    if (toolUse.kind === 'tool_use') {
      expect(toolUse.name).toBe('Read')
      expect(toolUse.result).toEqual({ ok: true, output: 'file body' })
    }
  })

  it('returns [] for an unknown session', () => {
    expect(readTranscript('does-not-exist')).toEqual([])
  })
})

describe('parentUuidOf / childUuidOf', () => {
  it('parentUuidOf finds the parent of a message', () => {
    expect(parentUuidOf(sessionId, 'a1')).toBe('u1')
    expect(parentUuidOf(sessionId, 'u1')).toBeNull()
  })

  it('childUuidOf finds the divergence message for an anchor', () => {
    expect(childUuidOf(sessionId, null)).toBe('u1') // first root-anchored message
    expect(childUuidOf(sessionId, 'a1')).toBe('u2')
  })
})

describe('editMessageText', () => {
  it('replaces a user message wholesale', () => {
    expect(editMessageText(sessionId, 'u1', 'goodbye')).toBe(true)
    expect(readTranscript(sessionId)[0].blocks[0]).toEqual({ kind: 'text', text: 'goodbye' })
  })

  it('collapses assistant text to one block while preserving thinking/tool_use order', () => {
    expect(editMessageText(sessionId, 'a1', 'edited answer')).toBe(true)
    const a = readTranscript(sessionId)[1]
    expect(a.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool_use'])
    expect(a.blocks[1]).toEqual({ kind: 'text', text: 'edited answer' })
  })

  it('reports false when the uuid is absent', () => {
    expect(editMessageText(sessionId, 'nope', 'x')).toBe(false)
  })
})
