import { describe, it, expect } from 'vitest'
import { zeroExpiredWindows } from './usage.js'
import type { UsageInfo } from '../shared/events.js'

const at = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString()
const info = (windows: UsageInfo['windows']): UsageInfo => ({ available: true, windows })

describe('zeroExpiredWindows', () => {
  it('zeros a window whose reset time has passed and drops the stale reset', () => {
    const out = zeroExpiredWindows(
      info([{ key: '5h', label: '5h', utilization: 90, resetsAt: at(-60_000) }])
    )
    expect(out.windows[0].utilization).toBe(0)
    expect(out.windows[0].resetsAt).toBeUndefined()
  })

  it('leaves a still-active window untouched', () => {
    const w = { key: '7d', label: '7d', utilization: 40, resetsAt: at(3_600_000) }
    expect(zeroExpiredWindows(info([w])).windows[0]).toEqual(w)
  })

  it('leaves a window with no reset time untouched', () => {
    const w = { key: 'x', label: 'x', utilization: 50 }
    expect(zeroExpiredWindows(info([w])).windows[0]).toEqual(w)
  })

  it('handles a mix — only expired windows are zeroed', () => {
    const out = zeroExpiredWindows(
      info([
        { key: '5h', label: '5h', utilization: 90, resetsAt: at(-1000) },
        { key: '7d', label: '7d', utilization: 55, resetsAt: at(86_400_000) }
      ])
    )
    expect(out.windows.map((w) => w.utilization)).toEqual([0, 55])
  })

  it('returns the same object when nothing is expired (no needless churn)', () => {
    const u = info([{ key: '7d', label: '7d', utilization: 20, resetsAt: at(1000) }])
    expect(zeroExpiredWindows(u)).toBe(u)
  })
})
