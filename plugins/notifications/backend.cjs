// Notifications service backend (kind: both, service: true). Runs as an isolated Electron utility
// process (never in-process — CLAUDE.md). It OWNS outbound HTTP delivery for the webhook-class
// channels (webhook/discord/slack/telegram/ntfy/pushover) so pings still go out with the pane
// closed. os-toast is pane-side (atelier.os.notify); the backend only asks the pane to fire one via
// the `notify:toast` DataBus channel (best-effort — no-op if the pane is closed).
//
// Protocol (see plugins/examples/tool-plugin/backend.cjs + PLUGIN_API.md):
//   parent → { hello: { pluginId, service, cwd? } }                      (spawn)
//   parent → { enable/disable: { conversationId, cwd? } }                (service toggle)
//   parent → { id, tool, input, conversationId? }        reply { id, result } | { id, error }
//   parent → { id, rpc: { conversationId, op, params } } reply { id, result } | { id, error }
//   backend → { id, storage: { op, conversationId, key?, value? } }  await { id, result|error }
//   backend → { publish: { conversationId, channel, data } }             (needs data:publish)
//
// Resilience: a channel HTTP failure is contained per-channel (Promise.allSettled); malformed
// settings yield a clear error, never a throw across the boundary; no crash loops (all handlers
// are wrapped). Node global `fetch` (Node 18+) does the HTTP — the backend is a trusted child.

const channels = require('./channels.cjs')
const { createRateLimiter } = require('./ratelimit.cjs')

const SETTINGS_KEY = 'settings'
const PINGLOG_KEY = 'pinglog'
const PINGLOG_MAX = 200
const LOG_CHANNEL = 'notify:log'
const TOAST_CHANNEL = 'notify:toast'

const rateLimiter = createRateLimiter()

// ---- storage request/response correlation (A8) ----
let __storageSeq = 0
const __storagePending = new Map()
function storageRequest(op, conversationId, key, value) {
  return new Promise((resolve, reject) => {
    const id = `storage:${++__storageSeq}`
    __storagePending.set(id, { resolve, reject })
    try {
      process.parentPort.postMessage({ id, storage: { op, conversationId, key, value } })
    } catch (err) {
      __storagePending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** Read + validate the pane-written settings for a conversation. Never throws — { error } on bad. */
async function loadSettings(conversationId) {
  let raw
  try {
    raw = await storageRequest('get', conversationId, SETTINGS_KEY)
  } catch (err) {
    return { error: `could not read settings: ${err && err.message ? err.message : String(err)}` }
  }
  if (raw == null) return { channels: [], eventToggles: {}, quietHours: null }
  if (typeof raw !== 'object') return { error: 'settings is malformed (not an object)' }
  const list = Array.isArray(raw.channels) ? raw.channels : []
  return {
    channels: list.filter((c) => c && typeof c === 'object'),
    eventToggles: raw.eventToggles && typeof raw.eventToggles === 'object' ? raw.eventToggles : {},
    quietHours: raw.quietHours && typeof raw.quietHours === 'object' ? raw.quietHours : null
  }
}

/** Append entries to the bounded (200) ping log in storage. Best-effort; delivery isn't blocked. */
async function appendLog(conversationId, entries) {
  if (!entries.length) return
  try {
    const existing = await storageRequest('get', conversationId, PINGLOG_KEY)
    const arr = Array.isArray(existing) ? existing : []
    const next = arr.concat(entries).slice(-PINGLOG_MAX)
    await storageRequest('set', conversationId, PINGLOG_KEY, next)
  } catch {
    // Storage unavailable (e.g. pane never opened this conversation) — the live publish still runs.
  }
}

/** Publish a value on a DataBus channel for the pane (needs data:publish). Best-effort. */
function publish(conversationId, channel, data) {
  try {
    process.parentPort.postMessage({ publish: { conversationId, channel, data } })
  } catch {
    /* parent gone */
  }
}

/** Deliver one notice over a set of channels. Returns { delivered:[names], failed:[{channel,error}],
 *  entries:[logEntry] }. Per-channel isolation via allSettled; os-toast is delegated to the pane. */
async function deliver(conversationId, notice, targetNames) {
  const settings = await loadSettings(conversationId)
  if (settings.error) {
    return { delivered: [], failed: [{ channel: 'settings', error: settings.error }], entries: [] }
  }
  let list = settings.channels.filter((c) => c.enabled !== false)
  if (Array.isArray(targetNames) && targetNames.length) {
    const want = new Set(targetNames.map((n) => String(n)))
    list = list.filter((c) => want.has(c.name) || want.has(c.type))
  }

  const delivered = []
  const failed = []
  const entries = []
  const now = Date.now()

  // os-toast: ask the pane to fire one (best-effort). Counts as "delivered" optimistically only if
  // an os-toast channel is configured+enabled; the pane logs the real outcome if it is open.
  const wantsToast = list.some((c) => c.type === 'os-toast')
  if (wantsToast) {
    publish(conversationId, TOAST_CHANNEL, {
      title: notice.title,
      body: notice.body,
      urgency: channels.normalizeUrgency(notice.urgency),
      tag: notice.event || undefined
    })
    delivered.push('os-toast')
    entries.push({
      ts: now,
      channel: 'os-toast',
      name: 'os-toast',
      ok: true,
      event: notice.event || 'agent-initiated',
      title: notice.title,
      note: 'requested pane toast (fires only if pane open)'
    })
  }

  const webhookChannels = list.filter((c) => c.type !== 'os-toast')
  const results = await Promise.allSettled(webhookChannels.map((c) => deliverOne(c, notice)))
  results.forEach((r, i) => {
    const c = webhookChannels[i]
    const name = c.name || c.type
    if (r.status === 'fulfilled' && r.value.ok) {
      delivered.push(name)
      entries.push({
        ts: now,
        channel: c.type,
        name,
        ok: true,
        event: notice.event,
        title: notice.title
      })
    } else {
      const error = r.status === 'fulfilled' ? r.value.error : String(r.reason && r.reason.message)
      failed.push({ channel: name, error })
      entries.push({
        ts: now,
        channel: c.type,
        name,
        ok: false,
        error,
        event: notice.event,
        title: notice.title
      })
    }
  })

  await appendLog(conversationId, entries)
  for (const e of entries) publish(conversationId, LOG_CHANNEL, e)
  return { delivered, failed, entries }
}

/** Deliver to a single webhook-class channel. Returns { ok:true } | { ok:false, error }. Contained. */
async function deliverOne(channel, notice) {
  const req = channels.buildRequest(channel, notice)
  if (req.error) return { ok: false, error: req.error }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let res
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        /* body unreadable */
      }
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` }
    }
    return { ok: true }
  } catch (err) {
    const msg =
      err && err.name === 'AbortError'
        ? 'request timed out'
        : err && err.message
          ? err.message
          : String(err)
    return { ok: false, error: msg }
  }
}

// ---- tool handler: notify_user (rate-capped) ----
async function handleNotifyUser(input, conversationId) {
  const title = input && input.title != null ? String(input.title) : ''
  const body = input && input.body != null ? String(input.body) : ''
  if (!title && !body)
    return { delivered: [], failed: [{ channel: '*', error: 'title or body required' }] }
  const gate = rateLimiter.check(conversationId || '_')
  if (!gate.ok) {
    return { delivered: [], failed: [{ channel: '*', error: gate.error }] }
  }
  const notice = {
    title,
    body,
    urgency: channels.normalizeUrgency(input && input.urgency),
    event: 'agent-initiated',
    conversation: conversationId || '',
    ts: Date.now()
  }
  const out = await deliver(conversationId, notice, input && input.channels)
  return { delivered: out.delivered, failed: out.failed }
}

// ---- RPC handlers (pane → backend) ----
const rpcOps = {
  // Send a test ping over one channel config the pane holds (may be unsaved). params: { channel }.
  async sendTest(params, conversationId) {
    const channel = params && params.channel
    if (!channel || typeof channel !== 'object') return { error: 'sendTest requires a channel' }
    const notice = {
      title: 'Atelier test',
      body: `Test notification for "${channel.name || channel.type}".`,
      urgency: 'normal',
      event: 'test',
      conversation: conversationId || '',
      ts: Date.now()
    }
    if (channel.type === 'os-toast') {
      publish(conversationId, TOAST_CHANNEL, {
        title: notice.title,
        body: notice.body,
        urgency: 'normal',
        tag: 'test'
      })
      const entry = {
        ts: notice.ts,
        channel: 'os-toast',
        name: 'os-toast',
        ok: true,
        event: 'test',
        title: notice.title,
        note: 'requested pane toast'
      }
      await appendLog(conversationId, [entry])
      publish(conversationId, LOG_CHANNEL, entry)
      return { ok: true, delivered: ['os-toast'], failed: [] }
    }
    const res = await deliverOne(channel, notice)
    const name = channel.name || channel.type
    const entry = {
      ts: notice.ts,
      channel: channel.type,
      name,
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      event: 'test',
      title: notice.title
    }
    await appendLog(conversationId, [entry])
    publish(conversationId, LOG_CHANNEL, entry)
    return res.ok
      ? { ok: true, delivered: [name], failed: [] }
      : { ok: false, delivered: [], failed: [{ channel: name, error: res.error }] }
  },
  // Immediate send driven by the pane's auto-event watcher (already toggle/quiet-hours-filtered).
  // params: { title, body, urgency?, event?, channels? }. NOT rate-limited (auto pings self-debounce).
  async send(params, conversationId) {
    const notice = {
      title: params && params.title != null ? String(params.title) : '',
      body: params && params.body != null ? String(params.body) : '',
      urgency: channels.normalizeUrgency(params && params.urgency),
      event: (params && params.event) || 'auto',
      conversation: conversationId || '',
      ts: Date.now()
    }
    const out = await deliver(conversationId, notice, params && params.channels)
    return { delivered: out.delivered, failed: out.failed }
  }
}

process.parentPort.on('message', (e) => {
  const msg = (e && e.data) || {}
  // A8 storage reply.
  if (msg.id !== undefined && typeof msg.id === 'string' && __storagePending.has(msg.id)) {
    const p = __storagePending.get(msg.id)
    __storagePending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
    return
  }
  // A7 panel RPC.
  if (msg.rpc && typeof msg.rpc === 'object') {
    const { id, rpc } = msg
    const fn = rpcOps[rpc.op]
    if (!fn) {
      process.parentPort.postMessage({ id, error: `unknown rpc op: ${rpc.op}` })
      return
    }
    Promise.resolve()
      .then(() => fn(rpc.params || {}, rpc.conversationId))
      .then((result) => process.parentPort.postMessage({ id, result }))
      .catch((err) =>
        process.parentPort.postMessage({
          id,
          error: err && err.message ? err.message : String(err)
        })
      )
    return
  }
  // Tool invoke.
  if (msg.tool !== undefined) {
    const { id, tool, input, conversationId } = msg
    if (tool !== 'notify_user') {
      process.parentPort.postMessage({ id, error: `unknown tool: ${tool}` })
      return
    }
    Promise.resolve()
      .then(() => handleNotifyUser(input || {}, conversationId))
      .then((result) => process.parentPort.postMessage({ id, result }))
      .catch((err) =>
        process.parentPort.postMessage({
          id,
          error: err && err.message ? err.message : String(err)
        })
      )
    return
  }
  // Lifecycle (hello/enable/disable) — nothing to bootstrap; settings are read per-delivery.
})
