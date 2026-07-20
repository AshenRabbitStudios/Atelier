import { describe, it, expect } from 'vitest'
import { OsNotifier, RATE_WINDOW_MS, type NotifyDeps, type HostNotification } from './osNotify.js'

// A controllable clock + a fake notification surface so the rate cap / tag coalescing are testable
// without Electron.
function makeDeps(overrides: Partial<NotifyDeps> = {}) {
  let now = 1_000_000 // start well past the rate window so the first notify is never capped
  const shown: { title: string; body: string; silent: boolean; closed: boolean }[] = []
  const clicks: { pluginId: string; id: string }[] = []
  let focused = false
  let flashed = false
  let badge = 0
  const clickHandlers: (() => void)[] = []
  const deps: NotifyDeps = {
    show: (opts, onClick) => {
      const rec = { ...opts, closed: false }
      shown.push(rec)
      clickHandlers.push(onClick)
      const handle: HostNotification = {
        close: () => {
          rec.closed = true
        }
      }
      return handle
    },
    focusWindow: () => {
      focused = true
    },
    flashFrame: (on) => {
      flashed = on
    },
    setBadgeCount: (n) => {
      badge = n
    },
    isWindowFocused: () => focused,
    emitClick: (pluginId, id) => clicks.push({ pluginId, id }),
    now: () => now,
    ...overrides
  }
  return {
    deps,
    shown,
    clicks,
    clickHandlers,
    advance: (ms: number) => {
      now += ms
    },
    get flashed() {
      return flashed
    },
    get badge() {
      return badge
    }
  }
}

describe('OsNotifier', () => {
  it('shows a notification and returns an id', () => {
    const h = makeDeps()
    const n = new OsNotifier(h.deps)
    const r = n.notify('p1', { title: 'Hi', body: 'there' })
    expect(r).toHaveProperty('id')
    expect(h.shown[0]).toMatchObject({ title: 'Hi', body: 'there', silent: true })
  })

  it('is silent unless sound is requested', () => {
    const h = makeDeps()
    const n = new OsNotifier(h.deps)
    n.notify('p1', { title: 'a', body: 'b', sound: true })
    expect(h.shown[0].silent).toBe(false)
  })

  it('rate-caps a plugin to one notification per window', () => {
    const h = makeDeps()
    const n = new OsNotifier(h.deps)
    expect(n.notify('p1', { title: 'a', body: '' })).toHaveProperty('id')
    expect(n.notify('p1', { title: 'b', body: '' })).toMatchObject({
      error: expect.stringContaining('rate limit')
    })
    h.advance(RATE_WINDOW_MS)
    expect(n.notify('p1', { title: 'c', body: '' })).toHaveProperty('id')
    expect(h.shown.length).toBe(2)
  })

  it('coalesces same-tag notifications (closes the prior) and exempts the replacement from the cap', () => {
    const h = makeDeps()
    const n = new OsNotifier(h.deps)
    n.notify('p1', { title: 'v1', body: '', tag: 'status' })
    // Same tag within the window is a replacement, not a cap violation.
    const r = n.notify('p1', { title: 'v2', body: '', tag: 'status' })
    expect(r).toHaveProperty('id')
    expect(h.shown[0].closed).toBe(true) // prior closed
    expect(h.shown[1].closed).toBe(false)
  })

  it('focuses the window and emits a click when a notification is clicked', () => {
    const h = makeDeps()
    const n = new OsNotifier(h.deps)
    const r = n.notify('p1', { title: 'a', body: '' })
    h.clickHandlers[0]() // simulate the user clicking it
    expect(n.isWindowFocused()).toBe(true)
    expect(h.clicks[0]).toMatchObject({ pluginId: 'p1', id: (r as { id: string }).id })
  })

  it('flashFrame / setBadgeCount are best-effort and swallow errors', () => {
    const h = makeDeps({
      flashFrame: () => {
        throw new Error('unsupported')
      }
    })
    const n = new OsNotifier(h.deps)
    expect(() => n.flashFrame(true)).not.toThrow()
    n.setBadgeCount(5)
    expect(h.badge).toBe(5)
  })
})
