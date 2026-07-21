// http-workbench — pure helpers shared by the backend (require) and unit tests. Loaded
// browser-side too (UMD-ish: attaches window.HWShared) so the pane redacts/digests with
// the exact same rules as the backend. No Node built-ins, no DOM.
;(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.HWShared = api
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  // Mirrors electron/plugin/netFetch.ts — the pane path goes through the host fetcher and
  // gets these enforced there; the backend path enforces them itself with the same values.
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
  const MAX_REQUEST_BYTES = 2_000_000
  const MAX_RESPONSE_BYTES = 4_000_000
  const DEFAULT_TIMEOUT_MS = 30_000
  const MAX_TIMEOUT_MS = 60_000

  // History size discipline (design §5.2).
  const HISTORY_CAP = 50
  const STORE_REQ_BODY_CAP = 8 * 1024
  const STORE_RESP_BODY_CAP = 64 * 1024
  const TOOL_RESP_BODY_CAP = 16 * 1024
  const DIGEST_ENTRIES = 12
  const DIGEST_SNIPPET = 200

  // Auth-style request headers never reach storage or context whole (design §8).
  const SECRET_HEADER_RE =
    /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token|cookie)$/i

  function redactHeaders(headers) {
    const out = {}
    if (!headers || typeof headers !== 'object') return out
    for (const k of Object.keys(headers)) {
      const v = String(headers[k] == null ? '' : headers[k])
      if (SECRET_HEADER_RE.test(k)) {
        out[k] = v.length > 8 ? v.slice(0, 4) + '•••' + v.slice(-2) : '•••'
      } else {
        out[k] = v
      }
    }
    return out
  }

  function cap(text, n) {
    const s = String(text == null ? '' : text)
    return s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false }
  }

  /* Build a stored history entry from a request + outcome. `resp` is either
     { status, statusText, headers, bodyText?, bodyBase64?, bodySize } or { error }. */
  function makeEntry(source, req, resp, timingMs, now) {
    const reqBody = cap(req.body || '', STORE_REQ_BODY_CAP)
    const entry = {
      id: 'h_' + now + '_' + Math.random().toString(36).slice(2, 7),
      ts: now,
      source, // 'user' | 'agent'
      method: req.method,
      url: req.url,
      reqHeaders: redactHeaders(req.headers),
      reqBody: reqBody.text,
      reqBodyTruncated: reqBody.truncated,
      timingMs
    }
    if (resp.error) {
      entry.error = String(resp.error)
      return entry
    }
    entry.status = resp.status
    entry.statusText = resp.statusText || ''
    entry.respHeaders = resp.headers || {}
    entry.bodySize = resp.bodySize || 0
    if (resp.bodyBase64 != null) {
      entry.binary = true
    } else {
      const body = cap(resp.bodyText || '', STORE_RESP_BODY_CAP)
      entry.respBody = body.text
      entry.respBodyTruncated = body.truncated
    }
    return entry
  }

  function appendHistory(list, entry) {
    const arr = Array.isArray(list) ? list.slice() : []
    arr.unshift(entry)
    return arr.slice(0, HISTORY_CAP)
  }

  /* The readonly ctx:history markdown digest (design §5.1) — most recent first, trimmed
     snippets, no full bodies, no raw auth headers (entries are already redacted). */
  function buildDigest(history) {
    const list = (Array.isArray(history) ? history : []).slice(0, DIGEST_ENTRIES)
    if (!list.length) return 'No HTTP requests fired yet in this conversation.'
    const lines = ['# HTTP request history (most recent first)', '']
    for (const e of list) {
      const status = e.error
        ? 'ERROR: ' + oneLine(e.error, 60)
        : e.status + (e.statusText ? ' ' + e.statusText : '')
      lines.push(
        '- ' +
          e.method +
          ' ' +
          e.url +
          ' → ' +
          status +
          (e.timingMs != null ? ' · ' + e.timingMs + 'ms' : '') +
          ' · ' +
          e.source
      )
      const bits = []
      if (e.reqBody) bits.push('req: ' + oneLine(e.reqBody, DIGEST_SNIPPET))
      if (e.binary) bits.push('resp: (binary, ' + (e.bodySize || 0) + ' bytes)')
      else if (e.respBody)
        bits.push(
          'resp: ' +
            oneLine(e.respBody, DIGEST_SNIPPET) +
            (e.respBodyTruncated || (e.bodySize || 0) > DIGEST_SNIPPET
              ? ' (body ' + fmtBytes(e.bodySize || 0) + ')'
              : '')
        )
      if (bits.length) lines.push('  ' + bits.join(' · '))
    }
    return lines.join('\n')
  }

  function oneLine(s, n) {
    const t = String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim()
    return t.length > n ? t.slice(0, n - 1) + '…' : t
  }

  function fmtBytes(n) {
    if (!n || n < 1024) return (n || 0) + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / (1024 * 1024)).toFixed(1) + ' MB'
  }

  /* Validate + normalize tool/builder input. Returns { req } | { error }. */
  function normalizeRequest(input) {
    if (!input || typeof input !== 'object') return { error: 'request required' }
    const url = String(input.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return { error: 'URL must be http(s)' }
    const method = String(input.method || 'GET').toUpperCase()
    if (METHODS.indexOf(method) < 0) return { error: 'method must be one of ' + METHODS.join('/') }
    const headers = {}
    if (input.headers && typeof input.headers === 'object') {
      for (const k of Object.keys(input.headers)) {
        if (/^cookie$/i.test(k)) continue // dropped, mirroring the host fetcher
        const v = input.headers[k]
        if (v != null) headers[k] = String(v)
      }
    }
    let body
    if (input.body != null && method !== 'GET' && method !== 'HEAD') {
      body = String(input.body)
      if (body.length > MAX_REQUEST_BYTES) return { error: 'request body too large (max 2MB)' }
    }
    let timeoutMs = Number(input.timeoutMs)
    if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS
    timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS)
    return { req: { url, method, headers, body, timeoutMs } }
  }

  return {
    METHODS,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    HISTORY_CAP,
    TOOL_RESP_BODY_CAP,
    SECRET_HEADER_RE,
    redactHeaders,
    makeEntry,
    appendHistory,
    buildDigest,
    normalizeRequest,
    oneLine,
    fmtBytes,
    cap
  }
})
