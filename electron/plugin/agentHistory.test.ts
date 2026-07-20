import { describe, it, expect } from 'vitest'
import { AgentHistoryRing, HISTORY_CAP, DEFAULT_LIMIT } from './agentHistory.js'
import type { AgentEvent } from '../shared/events.js'

function ev(instanceId: string, delta: string): AgentEvent {
  return { instanceId, kind: 'text', messageId: 'm', index: 0, delta }
}

describe('AgentHistoryRing', () => {
  it('returns events oldest→newest', () => {
    const ring = new AgentHistoryRing()
    ring.record(ev('c1', 'a'))
    ring.record(ev('c1', 'b'))
    ring.record(ev('c1', 'c'))
    const got = ring.get('c1')
    expect(got.map((e) => (e.kind === 'text' ? e.delta : ''))).toEqual(['a', 'b', 'c'])
  })

  it('bounds the ring at HISTORY_CAP (drops the oldest)', () => {
    const ring = new AgentHistoryRing()
    for (let i = 0; i < HISTORY_CAP + 50; i++) ring.record(ev('c1', String(i)))
    const got = ring.get('c1', HISTORY_CAP)
    expect(got.length).toBe(HISTORY_CAP)
    // The oldest kept is #50 (the first 50 were dropped); newest is the last written.
    expect(got[0].kind === 'text' && got[0].delta).toBe('50')
    expect(got[got.length - 1].kind === 'text' && got[got.length - 1].delta).toBe(
      String(HISTORY_CAP + 49)
    )
  })

  it('honours the default limit (200) and clamps to max', () => {
    const ring = new AgentHistoryRing()
    for (let i = 0; i < 500; i++) ring.record(ev('c1', String(i)))
    expect(ring.get('c1').length).toBe(DEFAULT_LIMIT)
    expect(ring.get('c1', 999999).length).toBe(500) // clamped to HISTORY_CAP, but only 500 exist
    expect(ring.get('c1', 10).length).toBe(10)
  })

  it('isolates conversations and clears one without affecting the other', () => {
    const ring = new AgentHistoryRing()
    ring.record(ev('c1', 'x'))
    ring.record(ev('c2', 'y'))
    expect(ring.get('c1').length).toBe(1)
    ring.clear('c1')
    expect(ring.get('c1')).toEqual([])
    expect(ring.get('c2').length).toBe(1)
  })
})
