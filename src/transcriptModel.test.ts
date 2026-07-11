import { describe, expect, it } from 'vitest'
import type { AgentEvent, UiStateSnapshot } from '@shared/events'
import { initialState, reduce, type TranscriptState } from './transcriptModel'

const snapshot = (over: Partial<UiStateSnapshot> = {}): UiStateSnapshot => ({
  status: 'working',
  permissionMode: 'bypassPermissions',
  pending: [
    {
      requestId: 'r1',
      toolUseId: 't1',
      toolName: 'Bash',
      title: 'Bash',
      input: { command: 'ls' },
      canAllowAlways: false
    }
  ],
  questions: [],
  background: [],
  autoResumeAt: null,
  autoResumeEnabled: false,
  tokens: { output: 42, input: 7 },
  turnStartedAt: null,
  ...over
})

const ev = (state: TranscriptState, event: AgentEvent): TranscriptState =>
  reduce(state, { type: 'event', event })

describe('hydrate (mount-time resync to main)', () => {
  it('replaces live state (status, mode, pending, tokens) but keeps messages', () => {
    let s = reduce(initialState, { type: 'user', id: 'u1', text: 'hi' })
    s = reduce(s, { type: 'hydrate', snapshot: snapshot() })
    expect(s.status).toBe('working')
    expect(s.permissionMode).toBe('bypassPermissions')
    expect(s.pending).toHaveLength(1)
    expect(s.pending[0].requestId).toBe('r1')
    expect(s.liveTokens).toEqual({ output: 42, input: 7 })
    expect(s.messages).toHaveLength(1) // transcript is hydrated separately
  })

  it('restores a pending approval a remount would otherwise have lost', () => {
    const s = reduce(initialState, { type: 'hydrate', snapshot: snapshot() })
    expect(s.pending[0].toolName).toBe('Bash')
    // ...and a later resolution event still clears it.
    const done = ev(s, { instanceId: 'i', kind: 'permission_resolved', requestId: 'r1' })
    expect(done.pending).toHaveLength(0)
  })

  it('does not duplicate a hydrated request when its push event also arrives', () => {
    let s = reduce(initialState, { type: 'hydrate', snapshot: snapshot() })
    s = ev(s, {
      instanceId: 'i',
      kind: 'permission_request',
      requestId: 'r1',
      toolUseId: 't1',
      toolName: 'Bash',
      title: 'Bash',
      input: { command: 'ls' },
      canAllowAlways: false
    })
    expect(s.pending).toHaveLength(1)
  })

  it('hydrates an idle snapshot over a stale working display', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'working' })
    s = reduce(s, {
      type: 'hydrate',
      snapshot: snapshot({ status: 'idle', pending: [], tokens: { output: 0 } })
    })
    expect(s.status).toBe('idle')
    expect(s.pending).toHaveLength(0)
  })

  it('carries the turn clock anchor and auto-resume flag from the snapshot', () => {
    const s = reduce(initialState, {
      type: 'hydrate',
      snapshot: snapshot({ turnStartedAt: 12345, autoResumeEnabled: true })
    })
    expect(s.turnStartedAt).toBe(12345)
    expect(s.autoResumeEnabled).toBe(true)
  })
})

describe('turn clock (elapsed anchor survives remounts)', () => {
  it('anchors on the first transition to working and keeps it across repeats', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'working' })
    expect(s.turnStartedAt).not.toBeNull()
    const anchor = s.turnStartedAt
    s = ev(s, { instanceId: 'i', kind: 'status', status: 'working' }) // queued turn, same run
    expect(s.turnStartedAt).toBe(anchor)
  })

  it('clears the anchor when the run ends', () => {
    let s = ev(initialState, { instanceId: 'i', kind: 'status', status: 'working' })
    s = ev(s, { instanceId: 'i', kind: 'status', status: 'idle' })
    expect(s.turnStartedAt).toBeNull()
  })

  it('set-auto-resume flips the flag', () => {
    const s = reduce(initialState, { type: 'set-auto-resume', enabled: true })
    expect(s.autoResumeEnabled).toBe(true)
  })
})
