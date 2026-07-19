import { describe, expect, it } from 'vitest'
import { TurnLedger, deriveStatus, type StatusFacts } from './turnLedger.js'

const facts = (busy: boolean, over: Partial<StatusFacts> = {}): StatusFacts => ({
  closed: false,
  wedged: false,
  busy,
  ...over
})

describe('TurnLedger', () => {
  it('releases at most one turn at a time', () => {
    const l = new TurnLedger()
    l.enqueue('a')
    l.enqueue('b')
    const first = l.release()
    expect(first?.text).toBe('a')
    // Second release is a no-op while `a` is in flight — double-release is impossible.
    expect(l.release()).toBeNull()
    expect(l.released?.text).toBe('a')
    expect(l.depth).toBe(1)
  })

  it('settle ends the in-flight turn and unlocks the next release', () => {
    const l = new TurnLedger()
    l.enqueue('a')
    l.enqueue('b')
    l.release()
    expect(l.settle()?.text).toBe('a')
    expect(l.released).toBeNull()
    expect(l.release()?.text).toBe('b')
  })

  it('settle with nothing in flight returns null (the invariant-breach signal)', () => {
    const l = new TurnLedger()
    expect(l.settle()).toBeNull()
    l.enqueue('a') // queued but NOT released — still a breach if a result arrives now
    expect(l.settle()).toBeNull()
  })

  it('release with an empty queue is a no-op', () => {
    const l = new TurnLedger()
    expect(l.release()).toBeNull()
    expect(l.busy).toBe(false)
  })

  it('clear drops the pipeline and reports everything dropped', () => {
    const l = new TurnLedger()
    l.enqueue('a')
    l.enqueue('b')
    l.enqueue('c')
    l.release()
    const dropped = l.clear()
    expect(dropped.released?.text).toBe('a')
    expect(dropped.queued.map((t) => t.text)).toEqual(['b', 'c'])
    expect(l.busy).toBe(false)
    expect(l.released).toBeNull()
    expect(l.depth).toBe(0)
  })

  it('assigns unique ids across enqueues', () => {
    const l = new TurnLedger()
    const a = l.enqueue('a')
    const b = l.enqueue('b')
    expect(a.id).not.toBe(b.id)
  })

  it('holds the invariant busy ⟺ (released ∨ queued) over arbitrary operation orders', () => {
    // Deterministic pseudo-random walk over the op space; the invariant must hold after
    // every step regardless of order (this is what "always correct" means mechanically).
    const l = new TurnLedger()
    let seed = 42
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 2000; i++) {
      const op = Math.floor(rand() * 4)
      if (op === 0) l.enqueue(`m${i}`)
      else if (op === 1) l.release()
      else if (op === 2) l.settle()
      else l.clear()
      expect(l.busy).toBe(l.released !== null || l.depth > 0)
    }
  })
})

describe('deriveStatus', () => {
  it('derives the full matrix with closed > wedged > busy precedence', () => {
    expect(deriveStatus(facts(false))).toBe('idle')
    expect(deriveStatus(facts(true))).toBe('working')
    expect(deriveStatus(facts(true, { wedged: true }))).toBe('error')
    expect(deriveStatus(facts(false, { wedged: true }))).toBe('error')
    expect(deriveStatus(facts(true, { closed: true, wedged: true }))).toBe('closed')
    expect(deriveStatus(facts(false, { closed: true }))).toBe('closed')
  })
})
