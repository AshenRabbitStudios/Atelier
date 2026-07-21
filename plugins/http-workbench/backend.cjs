// http-workbench backend (kind: both). Handles the agent's `http_request` tool: performs
// the fetch (Node global fetch in the utility process — same posture as the notifications
// backend's webhook delivery), appends the entry to the SAME per-(conversation, plugin)
// storage history the pane uses (A8 storage protocol), and publishes it on the
// `http:entry` DataBus channel so an open pane merges it live.
//
// DEVIATION from designs/http-workbench.md §4.4 (recorded in docs/PROGRESS.md): the design
// prefers the HOST performing the tool's fetch behind the pane's net:fetch permission. That
// relay wiring does not exist; the backend performs the fetch itself, mirroring the host
// fetcher's constraints exactly (method allow-list, cookie dropped, 2MB request / 4MB
// response caps, 60s max timeout) via shared.cjs so the two pipes behave identically.
// The ctx:history digest is maintained by the pane (live when open, rebuilt on mount).
//
// Protocol (see plugins/notifications/backend.cjs):
//   parent → { id, tool, input, conversationId }         reply { id, result } | { id, error }
//   backend → { id, storage: { op, conversationId, key?, value? } }  await { id, result|error }
//   backend → { publish: { conversationId, channel, data } }          (needs data:publish)
// Every failure is a { error } result — never a throw across the boundary.

'use strict'

const shared = require('./shared.cjs')

const HISTORY_KEY = 'history'
const ENTRY_CHANNEL = 'http:entry'

// ---- A8 storage request/response correlation ----
let storageSeq = 0
const storagePending = new Map()
function storageRequest(op, conversationId, key, value) {
  return new Promise((resolve, reject) => {
    const id = `storage:${++storageSeq}`
    storagePending.set(id, { resolve, reject })
    try {
      process.parentPort.postMessage({ id, storage: { op, conversationId, key, value } })
    } catch (err) {
      storagePending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

function publish(conversationId, channel, data) {
  try {
    process.parentPort.postMessage({ publish: { conversationId, channel, data } })
  } catch {
    /* parent gone */
  }
}

/* Perform the request with the same constraints the host fetcher enforces. Returns
   { status, statusText, headers, bodyText?|bodyBase64?, bodySize } | { error }. */
async function doFetch(req) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs)
  let res
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'follow',
      signal: controller.signal
    })
  } catch (err) {
    clearTimeout(timer)
    if (err && err.name === 'AbortError') return { error: `request timed out (${req.timeoutMs}ms)` }
    return { error: (err && err.cause && err.cause.message) || (err && err.message) || String(err) }
  }
  let buf
  try {
    buf = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    clearTimeout(timer)
    return { error: 'could not read response body: ' + ((err && err.message) || String(err)) }
  }
  clearTimeout(timer)
  if (buf.length > shared.MAX_RESPONSE_BYTES) {
    return { error: `response too large (${buf.length} bytes, max ${shared.MAX_RESPONSE_BYTES})` }
  }
  const headers = {}
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'set-cookie') return
    headers[k.toLowerCase()] = v
  })
  const ct = headers['content-type'] || ''
  const textish = /^text\/|json|xml|javascript|x-www-form-urlencoded|svg/i.test(ct) || ct === ''
  const out = {
    status: res.status,
    statusText: res.statusText || '',
    headers,
    bodySize: buf.length
  }
  if (textish) out.bodyText = buf.toString('utf8')
  else out.bodyBase64 = buf.toString('base64')
  return out
}

async function handleHttpRequest(input, conversationId) {
  const norm = shared.normalizeRequest(input)
  if (norm.error) return { error: norm.error }
  const req = norm.req

  const t0 = Date.now()
  const resp = await doFetch(req)
  const timingMs = Date.now() - t0

  // Shared history: append via A8 (works with the pane closed) + live push for an open pane.
  const entry = shared.makeEntry('agent', req, resp, timingMs, Date.now())
  try {
    const existing = await storageRequest('get', conversationId, HISTORY_KEY)
    await storageRequest('set', conversationId, HISTORY_KEY, shared.appendHistory(existing, entry))
  } catch {
    /* storage unavailable — the live publish still reaches an open pane */
  }
  publish(conversationId, ENTRY_CHANNEL, entry)

  if (resp.error) return { error: resp.error }

  // Capped result for the agent (large bodies are expensive tokens — design §5.3).
  const result = {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
    timingMs,
    bodySize: resp.bodySize
  }
  if (resp.bodyBase64 != null) {
    result.binary = true
    result.note = 'binary response (' + resp.bodySize + ' bytes) — body omitted'
  } else {
    const capped = shared.cap(resp.bodyText, shared.TOOL_RESP_BODY_CAP)
    result.bodyText = capped.text
    if (capped.truncated) result.truncated = true
  }
  return result
}

process.parentPort.on('message', (e) => {
  const msg = (e && e.data) || {}
  try {
    // A8 storage reply.
    if (msg.id !== undefined && typeof msg.id === 'string' && storagePending.has(msg.id)) {
      const p = storagePending.get(msg.id)
      storagePending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.result)
      return
    }
    // Tool invoke.
    if (msg.tool !== undefined) {
      const { id, tool, input, conversationId } = msg
      if (tool !== 'http_request') {
        process.parentPort.postMessage({ id, error: `unknown tool: ${tool}` })
        return
      }
      Promise.resolve()
        .then(() => handleHttpRequest(input || {}, conversationId))
        .then((result) => process.parentPort.postMessage({ id, result }))
        .catch((err) =>
          process.parentPort.postMessage({
            id,
            error: err && err.message ? err.message : String(err)
          })
        )
      return
    }
    // Lifecycle (hello/enable/disable) — stateless; nothing to do.
  } catch (err) {
    if (msg && msg.id !== undefined) {
      try {
        process.parentPort.postMessage({
          id: msg.id,
          error: err && err.message ? err.message : String(err)
        })
      } catch {
        /* parent gone */
      }
    }
  }
})
