// HTTP Workbench — pane logic. User requests go through atelier.net.fetch (the host
// fetcher, net:fetch permission); agent requests arrive as history entries over the
// http:entry DataBus channel (the backend fetched + stored them). One storage key
// ('history') holds the shared, capped, secret-redacted trail; the pane rebuilds the
// readonly ctx:history digest on every change. Responses render as inert data only.

const A = window.atelier
const HW = window.HWShared
const $ = (id) => document.getElementById(id)

const HISTORY_KEY = 'history'

const state = {
  history: [], // newest first (shared shape — shared.cjs makeEntry)
  selectedId: null,
  sending: false,
  lastFullResp: null // { id, resp } — the live (un-capped) response for the latest send
}

/* ── helpers ── */
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/* ── persistence + context digest ── */
async function persistHistory() {
  try {
    await A.storage.set(HISTORY_KEY, state.history)
  } catch (e) {
    /* best-effort */
  }
  refreshDigest()
}
function refreshDigest() {
  A.context.set('history', HW.buildDigest(state.history)).catch(() => {})
}

/* ── builder ── */
const methodSel = $('method')
HW.METHODS.forEach((m) => {
  const o = document.createElement('option')
  o.value = m
  o.textContent = m
  methodSel.appendChild(o)
})
methodSel.addEventListener('change', syncBodyVisibility)
function syncBodyVisibility() {
  const m = methodSel.value
  $('body-wrap').classList.toggle('hidden', m === 'GET' || m === 'HEAD')
}

function addHeaderRow(k, v) {
  const row = el('div', 'hdr-row')
  const key = document.createElement('input')
  key.type = 'text'
  key.className = 'k'
  key.placeholder = 'Header'
  key.value = k || ''
  const val = document.createElement('input')
  val.type = 'text'
  val.className = 'v'
  val.placeholder = 'value'
  val.value = v || ''
  const del = el('button', 'mini', '×')
  del.addEventListener('click', () => row.remove())
  row.appendChild(key)
  row.appendChild(val)
  row.appendChild(del)
  $('headers').appendChild(row)
  return row
}
$('add-header').addEventListener('click', () => addHeaderRow())
$('ct-quick').addEventListener('change', () => {
  const v = $('ct-quick').value
  $('ct-quick').value = ''
  if (!v) return
  // Reuse an existing content-type row if present.
  for (const row of $('headers').querySelectorAll('.hdr-row')) {
    const key = row.querySelector('.k')
    if (key && key.value.toLowerCase() === 'content-type') {
      row.querySelector('.v').value = v
      return
    }
  }
  addHeaderRow('Content-Type', v)
})

function collectHeaders() {
  const out = {}
  for (const row of $('headers').querySelectorAll('.hdr-row')) {
    const k = row.querySelector('.k').value.trim()
    const v = row.querySelector('.v').value
    if (k) out[k] = v
  }
  return out
}

function populateBuilder(entry) {
  methodSel.value = HW.METHODS.includes(entry.method) ? entry.method : 'GET'
  $('url').value = entry.url || ''
  clear($('headers'))
  const hdrs = entry.reqHeaders || {}
  for (const k of Object.keys(hdrs)) {
    // Redacted values are placeholders — the user re-enters the secret to replay.
    addHeaderRow(k, hdrs[k])
  }
  $('req-body').value = entry.reqBody || ''
  syncBodyVisibility()
}

/* ── send (user path — the host fetcher) ── */
$('send').addEventListener('click', sendRequest)
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendRequest()
})

async function sendRequest() {
  if (state.sending) return
  const norm = HW.normalizeRequest({
    url: $('url').value,
    method: methodSel.value,
    headers: collectHeaders(),
    body: $('req-body').value
  })
  if (norm.error) {
    renderError(norm.error)
    return
  }
  const req = norm.req
  state.sending = true
  const btn = $('send')
  btn.disabled = true
  btn.textContent = '…'
  const t0 = performance.now()
  let resp
  try {
    const r = await A.net.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      timeoutMs: req.timeoutMs
    })
    if (r && r.error) resp = { error: r.error }
    else {
      resp = {
        status: r.status,
        statusText: r.statusText || '',
        headers: r.headers || {},
        bodySize:
          r.bodyText != null
            ? r.bodyText.length
            : r.bodyBase64
              ? Math.floor(r.bodyBase64.length * 0.75)
              : 0
      }
      if (r.bodyBase64 != null) resp.bodyBase64 = r.bodyBase64
      else resp.bodyText = r.bodyText || ''
    }
  } catch (err) {
    resp = { error: (err && err.message) || String(err) }
  }
  const timingMs = Math.round(performance.now() - t0)
  state.sending = false
  btn.disabled = false
  btn.textContent = 'Send'

  const entry = HW.makeEntry('user', req, resp, timingMs, Date.now())
  state.lastFullResp = { id: entry.id, resp }
  state.history = HW.appendHistory(state.history, entry)
  state.selectedId = entry.id
  await persistHistory()
  renderHistory()
  renderResponse(entry)
}

/* ── response rendering (inert only — never innerHTML a response) ── */
function renderError(msg) {
  $('resp-empty').classList.add('hidden')
  const view = $('resp-view')
  view.classList.remove('hidden')
  clear($('resp-status'))
  $('resp-headers-sec').classList.add('hidden')
  const body = $('resp-body')
  clear(body)
  let friendly = msg
  if (/certificate|cert|TLS|SSL/i.test(String(msg))) {
    friendly = msg + ' — TLS cert not trusted; use http:// for local dev (no cert opt-in yet).'
  }
  body.appendChild(el('div', 'err-card', friendly))
}

function renderResponse(entry) {
  $('resp-empty').classList.add('hidden')
  const view = $('resp-view')
  view.classList.remove('hidden')
  const statusEl = $('resp-status')
  clear(statusEl)

  if (entry.error) {
    renderError(entry.error)
    return
  }

  const cls = 'code-' + Math.floor((entry.status || 0) / 100) + 'xx'
  statusEl.appendChild(el('span', cls, entry.status + ' ' + (entry.statusText || '')))
  statusEl.appendChild(
    el(
      'span',
      'resp-meta',
      (entry.timingMs != null ? entry.timingMs + 'ms round-trip · ' : '') +
        HW.fmtBytes(entry.bodySize || 0)
    )
  )
  statusEl.appendChild(el('span', 'resp-meta', entry.source === 'agent' ? 'fired by agent' : ''))

  // headers
  const hs = $('resp-headers-sec')
  hs.classList.remove('hidden')
  const ht = $('resp-headers')
  clear(ht)
  const hdrs = entry.respHeaders || {}
  for (const k of Object.keys(hdrs)) {
    const line = el('div')
    line.appendChild(el('span', 'hk', k + ': '))
    line.appendChild(document.createTextNode(String(hdrs[k])))
    ht.appendChild(line)
  }

  // body
  const bodyEl = $('resp-body')
  clear(bodyEl)
  if (entry.binary) {
    bodyEl.appendChild(el('div', 'jmeta', 'binary response · ' + HW.fmtBytes(entry.bodySize || 0)))
    return
  }
  // Prefer the live full body for the just-sent request; stored entries carry a capped body.
  let text = entry.respBody || ''
  if (
    state.lastFullResp &&
    state.lastFullResp.id === entry.id &&
    state.lastFullResp.resp.bodyText != null
  ) {
    text = state.lastFullResp.resp.bodyText
  }
  const ct = String((entry.respHeaders || {})['content-type'] || '')
  let rendered = false
  if (/json/i.test(ct) || looksLikeJson(text)) {
    try {
      const parsed = JSON.parse(text)
      bodyEl.appendChild(jsonTree(parsed, null, true))
      rendered = true
    } catch (e) {
      /* fall through to raw */
    }
  }
  if (!rendered) {
    const pre = el('pre')
    pre.textContent = text
    bodyEl.appendChild(pre)
  }
  if (entry.respBodyTruncated && !(state.lastFullResp && state.lastFullResp.id === entry.id)) {
    bodyEl.appendChild(
      el(
        'div',
        'jmeta',
        'stored body trimmed (' +
          HW.fmtBytes(entry.bodySize || 0) +
          ' total) — replay to see it whole'
      )
    )
  }
}

function looksLikeJson(t) {
  const s = String(t || '').trim()
  return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))
}

// Collapsible JSON tree — details/summary, text nodes only. Large arrays windowed.
const TREE_WINDOW = 100
function jsonTree(value, key, root) {
  const keyPrefix = key != null ? key + ': ' : ''
  if (value === null) return leaf(keyPrefix, 'null', 'jnull')
  if (typeof value === 'string') return leaf(keyPrefix, JSON.stringify(value), 'js')
  if (typeof value === 'number') return leaf(keyPrefix, String(value), 'jn')
  if (typeof value === 'boolean') return leaf(keyPrefix, String(value), 'jb')
  const isArr = Array.isArray(value)
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value)
  const d = document.createElement('details')
  d.className = 'jt' + (root ? ' jt-root' : '')
  if (root || entries.length <= 8) d.open = true
  const sum = document.createElement('summary')
  if (key != null) {
    sum.appendChild(el('span', 'jk', String(key) + ': '))
  }
  sum.appendChild(
    document.createTextNode(isArr ? '[' + entries.length + ']' : '{' + entries.length + '}')
  )
  d.appendChild(sum)
  const shown = entries.slice(0, TREE_WINDOW)
  for (const [k, v] of shown) {
    d.appendChild(jsonTree(v, k, false))
  }
  if (entries.length > TREE_WINDOW) {
    d.appendChild(
      el('div', 'jmeta jt', '… ' + (entries.length - TREE_WINDOW) + ' more entries (windowed)')
    )
  }
  return d

  function leaf(prefix, text, cls) {
    const line = el('div', 'jt')
    if (prefix) line.appendChild(el('span', 'jk', prefix))
    line.appendChild(el('span', cls, text))
    return line
  }
}

/* ── history ── */
function renderHistory() {
  const host = $('hist-list')
  clear(host)
  if (!state.history.length) {
    host.appendChild(
      el('div', 'hist-empty', 'No requests yet — history is shared between you and the agent.')
    )
    return
  }
  for (const entry of state.history) {
    const row = el('div', 'h-row' + (entry.id === state.selectedId ? ' selected' : ''))
    row.appendChild(el('span', 'h-method', entry.method))
    const u = el('span', 'h-url', entry.url)
    u.title = entry.url
    row.appendChild(u)
    const status = el(
      'span',
      'h-status ' +
        (entry.error ? 'code-5xx' : 'code-' + Math.floor((entry.status || 0) / 100) + 'xx'),
      entry.error ? 'ERR' : String(entry.status)
    )
    row.appendChild(status)
    if (entry.timingMs != null) row.appendChild(el('span', 'h-time', entry.timingMs + 'ms'))
    row.appendChild(el('span', 'h-src' + (entry.source === 'agent' ? ' agent' : ''), entry.source))
    row.appendChild(el('span', 'h-time', new Date(entry.ts).toLocaleTimeString()))
    row.addEventListener('click', () => {
      state.selectedId = entry.id
      renderHistory()
      renderResponse(entry)
      populateBuilder(entry) // replay-with-edit: original preserved, re-send appends new
    })
    host.appendChild(row)
  }
}

$('hist-clear').addEventListener('click', () => {
  state.history = []
  state.selectedId = null
  persistHistory()
  renderHistory()
})

/* ── live agent entries ── */
function onAgentEntry(entry) {
  if (!entry || typeof entry !== 'object' || !entry.id) return
  if (state.history.some((e) => e.id === entry.id)) return
  state.history = HW.appendHistory(state.history, entry)
  // The backend already wrote storage; just refresh UI + digest.
  refreshDigest()
  renderHistory()
  if (!state.selectedId || state.selectedId === entry.id) {
    state.selectedId = entry.id
    renderResponse(entry)
    renderHistory()
  }
}

/* ── mount ── */
let mounted = false
async function mount() {
  if (mounted) return
  mounted = true
  syncBodyVisibility()
  try {
    const saved = await A.storage.get(HISTORY_KEY)
    if (Array.isArray(saved)) state.history = saved.slice(0, HW.HISTORY_CAP)
  } catch (e) {
    /* first run */
  }
  renderHistory()
  refreshDigest()
  try {
    await A.data.subscribe('http:entry', onAgentEntry)
  } catch (e) {
    /* data:subscribe unavailable */
  }
}

A.on('load', mount)
mount()
