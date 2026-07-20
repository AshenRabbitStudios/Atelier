// Pure, framework-free channel payload builders + urgency mapping for the notifications plugin.
// CommonJS so backend.cjs can `require` it and the vitest unit test (electron/plugin/
// notificationsPayloads.test.ts) can import it. NOTHING here touches the network or process — a
// builder returns the HTTP request DESCRIPTOR { url, method, headers, body } (or { error }); the
// backend performs the fetch. This split is what makes the delivery logic headlessly testable.
//
// A "channel" is one user-configured destination: { id, type, enabled, name, config, events? }.
//   type ∈ webhook | discord | slack | telegram | ntfy | pushover  (os-toast is pane-side, not here)
//   config holds the secrets/urls the pane wrote (never exported to agent context).
// A "notice" is what we deliver: { title, body, urgency, event, conversation, ts }.

const URGENCIES = ['low', 'normal', 'high']

/** Normalize an urgency to one of the known levels (defaults to 'normal'). */
function normalizeUrgency(u) {
  return URGENCIES.includes(u) ? u : 'normal'
}

/** Trim a string to a max length (defensive against a channel's own limits). */
function clamp(s, max) {
  const str = s == null ? '' : String(s)
  return str.length > max ? str.slice(0, max - 1) + '…' : str
}

// ---- per-channel request builders ----
// Each returns { url, method, headers, body } | { error: string }. `body` is always a string
// (JSON.stringify'd where the endpoint wants JSON) so the backend's fetch is uniform.

function buildWebhook(config, notice) {
  const url = (config && config.url) || ''
  if (!url) return { error: 'webhook channel missing url' }
  let headers = { 'Content-Type': 'application/json' }
  if (config.headers) {
    // headers may be a JSON string (as typed in the pane) or an already-parsed object.
    let extra = config.headers
    if (typeof extra === 'string') {
      try {
        extra = JSON.parse(extra)
      } catch {
        return { error: 'webhook headers is not valid JSON' }
      }
    }
    if (extra && typeof extra === 'object') headers = { ...headers, ...extra }
  }
  const payload = {
    title: notice.title,
    body: notice.body,
    urgency: normalizeUrgency(notice.urgency),
    event: notice.event || 'agent-initiated',
    conversation: notice.conversation || '',
    ts: notice.ts || Date.now()
  }
  return { url, method: 'POST', headers, body: JSON.stringify(payload) }
}

function buildDiscord(config, notice) {
  const url = (config && config.url) || ''
  if (!url) return { error: 'discord channel missing webhook url' }
  const content = clamp(`**${notice.title}**\n${notice.body}`, 1900)
  return {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }
}

function buildSlack(config, notice) {
  const url = (config && config.url) || ''
  if (!url) return { error: 'slack channel missing webhook url' }
  const text = clamp(`*${notice.title}*\n${notice.body}`, 3000)
  return {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  }
}

function buildTelegram(config, notice) {
  const token = (config && config.botToken) || ''
  const chatId = (config && config.chatId) || ''
  if (!token) return { error: 'telegram channel missing bot token' }
  if (!chatId) return { error: 'telegram channel missing chat id' }
  const text = clamp(`${notice.title}\n${notice.body}`, 4000)
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  }
}

function buildNtfy(config, notice) {
  const server = ((config && config.server) || 'https://ntfy.sh').replace(/\/+$/, '')
  const topic = (config && config.topic) || ''
  if (!topic) return { error: 'ntfy channel missing topic' }
  // ntfy priority: high=5, normal=3, low=2 (its scale is 1..5, default 3).
  const priority = notice.urgency === 'high' ? '5' : notice.urgency === 'low' ? '2' : '3'
  const headers = {
    Title: encodeURIComponent(clamp(notice.title, 250)),
    Priority: priority
  }
  if (config && config.token) headers.Authorization = `Bearer ${config.token}`
  return {
    url: `${server}/${encodeURIComponent(topic)}`,
    method: 'POST',
    headers,
    body: clamp(notice.body, 4000)
  }
}

function buildPushover(config, notice) {
  const appToken = (config && config.appToken) || ''
  const userKey = (config && config.userKey) || ''
  if (!appToken) return { error: 'pushover channel missing app token' }
  if (!userKey) return { error: 'pushover channel missing user key' }
  // Pushover priority: high=1, normal=0, low=-1.
  const priority = notice.urgency === 'high' ? 1 : notice.urgency === 'low' ? -1 : 0
  const params = new URLSearchParams({
    token: appToken,
    user: userKey,
    title: clamp(notice.title, 250),
    message: clamp(notice.body, 1024),
    priority: String(priority)
  })
  return {
    url: 'https://api.pushover.net/1/messages.json',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  }
}

const BUILDERS = {
  webhook: buildWebhook,
  discord: buildDiscord,
  slack: buildSlack,
  telegram: buildTelegram,
  ntfy: buildNtfy,
  pushover: buildPushover
}

/** Known webhook-class (backend-delivered) channel types. os-toast is pane-side, excluded here. */
const BACKEND_CHANNEL_TYPES = Object.keys(BUILDERS)

/** Build the HTTP request descriptor for a channel + notice, or { error } if unbuildable. */
function buildRequest(channel, notice) {
  const fn = BUILDERS[channel && channel.type]
  if (!fn) return { error: `unknown channel type: ${channel && channel.type}` }
  return fn(channel.config || {}, notice)
}

module.exports = {
  URGENCIES,
  BACKEND_CHANNEL_TYPES,
  normalizeUrgency,
  clamp,
  buildRequest,
  buildWebhook,
  buildDiscord,
  buildSlack,
  buildTelegram,
  buildNtfy,
  buildPushover
}
