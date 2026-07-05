import type { UsageInfo } from '../shared/events.js'

/**
 * The SDK only reports rate-limit usage during/after a live turn; an idle session returns nothing,
 * so the app serves the last-known snapshot — which is even persisted across restarts and can be
 * hours old. That snapshot goes stale the moment a window resets, leaving the meter stuck on a
 * pre-reset percentage (e.g. 90% on a 5h window the account has since rolled over to 0%).
 *
 * Recompute against the clock on every read: any window whose `resetsAt` has passed has rolled
 * over, so its utilization is 0 and its (now meaningless) reset time is dropped. The next fresh
 * fetch during a turn repopulates the new window. This keeps the meter honest between fetches
 * instead of showing a value the account no longer has.
 */
export function zeroExpiredWindows(u: UsageInfo, now = Date.now()): UsageInfo {
  if (!u.windows.length) return u
  let changed = false
  const windows = u.windows.map((w) => {
    if (w.resetsAt && Date.parse(w.resetsAt) <= now) {
      changed = true
      return { ...w, utilization: 0, resetsAt: undefined }
    }
    return w
  })
  return changed ? { ...u, windows } : u
}
