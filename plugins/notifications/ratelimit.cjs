// Per-conversation rate limiter for the notify_user tool (spec §4): at most 1 ping / 10s AND at
// most 10 pings / hour, per conversation. Pure + injectable clock so it is headlessly testable
// (electron/plugin/notificationsPayloads.test.ts). Only agent-initiated notify_user calls are
// capped; auto-event pings have their own debounce/re-arm logic in the pane.
//
// Usage: const rl = createRateLimiter(); rl.check(conversationId, now?) -> { ok } | { ok:false, error }
// A successful check RECORDS the ping (advances the window); a failed one does not.

const MIN_INTERVAL_MS = 10_000 // ≤ 1 per 10s
const HOUR_MS = 60 * 60 * 1000
const MAX_PER_HOUR = 10 // ≤ 10 per hour

function createRateLimiter(opts = {}) {
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS
  const maxPerHour = opts.maxPerHour ?? MAX_PER_HOUR
  const windowMs = opts.windowMs ?? HOUR_MS
  // conversationId -> sorted-ish array of epoch-ms timestamps within the last hour
  const hits = new Map()

  function prune(list, now) {
    // Drop timestamps older than the hour window (kept small; called on each check).
    let i = 0
    while (i < list.length && now - list[i] >= windowMs) i++
    return i > 0 ? list.slice(i) : list
  }

  return {
    /** Returns { ok:true } and records the ping, or { ok:false, error } explaining the cap hit. */
    check(conversationId, now = Date.now()) {
      const cid = conversationId || '_'
      const list = prune(hits.get(cid) || [], now)
      const last = list.length ? list[list.length - 1] : -Infinity
      if (now - last < minInterval) {
        const wait = Math.ceil((minInterval - (now - last)) / 1000)
        hits.set(cid, list)
        return {
          ok: false,
          error: `rate limited: at most one notification per ${minInterval / 1000}s (try again in ~${wait}s)`
        }
      }
      if (list.length >= maxPerHour) {
        hits.set(cid, list)
        return {
          ok: false,
          error: `rate limited: at most ${maxPerHour} notifications per hour for this conversation`
        }
      }
      list.push(now)
      hits.set(cid, list)
      return { ok: true }
    },
    /** Test/introspection helper: current count in the window for a conversation. */
    count(conversationId, now = Date.now()) {
      const list = prune(hits.get(conversationId || '_') || [], now)
      hits.set(conversationId || '_', list)
      return list.length
    }
  }
}

module.exports = { createRateLimiter, MIN_INTERVAL_MS, MAX_PER_HOUR, HOUR_MS }
