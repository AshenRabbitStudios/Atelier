// Workspace Explorer — a lazy file tree of the conversation cwd with an agent-activity heat
// overlay (reads vs. writes, decaying over time), click-to-preview (with a live file: tail),
// double-click-to-open-externally, and right-click "mention in chat".
//
// Runs in the sandboxed plugin iframe; reaches the app only through window.atelier. All durable
// state (expansion set, hide-ignored toggle, heat records, decay half-life, freeze flag) lives in
// atelier.storage so every mount is a correct restore (PLUGIN_API §8).

const atelier = window.atelier
const $ = (id) => document.getElementById(id)

// ---- Storage keys ----
const K_EXPANDED = 'expanded' // string[] of dir paths currently open
const K_HIDE_IGNORED = 'hideIgnored' // '1' | '0'
const K_HEAT = 'heat' // { path, kind:'read'|'write', ts }[] (bounded ring)
const K_HALFLIFE = 'halfLifeMs' // number
const K_FROZEN = 'frozen' // '1' | '0'

// ---- Tuning ----
const HEAT_CAP = 1000 // bounded activity ring
const DEFAULT_HALFLIFE_MS = 90_000 // ~90s half-life (spec §2)
const HEAT_EPSILON = 0.02 // below this a row is treated as cold (skips render churn)
const PREVIEW_MAX_BYTES = 128 * 1024 // truncate previews past 128 KB (spec §2/§6)
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i

// ---- Read/write tool classification (spec §4b; SDK built-in tool names) ----
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

// =====================================================================================
// State
// =====================================================================================
const state = {
  cwd: '', // absolute conversation cwd (from agent.info)
  expanded: new Set(), // dir paths (cwd-relative, '' = root) currently open
  hideIgnored: false,
  frozen: false,
  halfLifeMs: DEFAULT_HALFLIFE_MS,
  heat: [], // { path, kind, ts }[] newest-appended, capped
  nodes: new Map(), // path -> { name, kind, ignored, size, childrenLoaded, entries }
  selected: null, // currently previewed cwd-relative path
  previewChannel: null, // the file: DataBus channel we're tailing, if any
  previewCollapsed: true,
  previewRaw: null, // latest raw text of the selected file (re-rendered on mode switch)
  previewMode: 'code' // 'code' | 'rendered' | 'pretty' (per-extension, persisted)
}

// =====================================================================================
// Path helpers (posix, cwd-relative)
// =====================================================================================
function normSlash(p) {
  return p.replace(/\\/g, '/')
}

function joinRel(dir, name) {
  return dir ? dir + '/' + name : name
}

function baseName(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

function dirOf(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

// Convert an absolute SDK tool path to a cwd-relative one; returns null if outside the cwd.
function toRel(absPath) {
  if (!absPath || typeof absPath !== 'string') return null
  const abs = normSlash(absPath)
  const cwd = normSlash(state.cwd).replace(/\/$/, '')
  if (!cwd) return null
  if (abs === cwd) return ''
  const prefix = cwd + '/'
  if (abs.toLowerCase().startsWith(prefix.toLowerCase())) return abs.slice(prefix.length)
  return null
}

// =====================================================================================
// Storage (fire-and-forget persistence; every write is durable)
// =====================================================================================
async function loadPersisted() {
  try {
    const [expanded, hide, heat, halfLife, frozen] = await Promise.all([
      atelier.storage.get(K_EXPANDED),
      atelier.storage.get(K_HIDE_IGNORED),
      atelier.storage.get(K_HEAT),
      atelier.storage.get(K_HALFLIFE),
      atelier.storage.get(K_FROZEN)
    ])
    if (Array.isArray(expanded))
      state.expanded = new Set(expanded.filter((x) => typeof x === 'string'))
    state.hideIgnored = hide === '1'
    state.frozen = frozen === '1'
    if (typeof halfLife === 'number' && halfLife > 0) state.halfLifeMs = halfLife
    if (Array.isArray(heat)) {
      state.heat = heat
        .filter(
          (r) =>
            r &&
            typeof r.path === 'string' &&
            (r.kind === 'read' || r.kind === 'write') &&
            typeof r.ts === 'number'
        )
        .slice(-HEAT_CAP)
    }
  } catch (_) {
    /* first mount / host not ready — defaults stand */
  }
}

function persistExpanded() {
  atelier.storage.set(K_EXPANDED, Array.from(state.expanded)).catch(() => {})
}
function persistHeat() {
  atelier.storage.set(K_HEAT, state.heat).catch(() => {})
}
function persistToggle() {
  atelier.storage.set(K_HIDE_IGNORED, state.hideIgnored ? '1' : '0').catch(() => {})
}
function persistFrozen() {
  atelier.storage.set(K_FROZEN, state.frozen ? '1' : '0').catch(() => {})
}

// =====================================================================================
// Heat model — records in, decayed intensity out (decay computed AT RENDER, no timers)
// =====================================================================================
function recordActivity(path, kind) {
  const rec = { path, kind, ts: Date.now() }
  state.heat.push(rec)
  if (state.heat.length > HEAT_CAP) state.heat.splice(0, state.heat.length - HEAT_CAP)
  persistHeat()
}

// Per-file heat, split by kind, decayed to `now`. Multiple hits accumulate (capped at 1) so a
// file read 3× glows brighter than one read once. When frozen we anchor decay to the freeze time
// (stored as state.frozenAt) so the picture holds still.
function heatFor(path, now) {
  let read = 0
  let write = 0
  let readCount = 0
  let writeCount = 0
  let last = 0
  const anchor = state.frozen && state.frozenAt ? state.frozenAt : now
  for (let i = 0; i < state.heat.length; i++) {
    const r = state.heat[i]
    if (r.path !== path) continue
    const age = Math.max(0, anchor - r.ts)
    const v = Math.pow(0.5, age / state.halfLifeMs)
    if (r.kind === 'read') {
      read += v
      readCount++
    } else {
      write += v
      writeCount++
    }
    if (r.ts > last) last = r.ts
  }
  return {
    read: Math.min(1, read),
    write: Math.min(1, write),
    readCount,
    writeCount,
    last
  }
}

// Folder rollup: the max descendant heat, so a collapsed dir still signals activity inside it.
// O(records) per folder — cheap because the ring is bounded. Uses a path-prefix test.
function rollupHeatFor(dirPath, now) {
  const prefix = dirPath ? dirPath + '/' : ''
  let read = 0
  let write = 0
  const anchor = state.frozen && state.frozenAt ? state.frozenAt : now
  for (let i = 0; i < state.heat.length; i++) {
    const r = state.heat[i]
    if (prefix && !r.path.startsWith(prefix)) continue
    if (!prefix && r.path.indexOf('/') < 0) continue // root dir's own direct children handled per-node
    const age = Math.max(0, anchor - r.ts)
    const v = Math.pow(0.5, age / state.halfLifeMs)
    if (r.kind === 'read') read = Math.max(read, v)
    else write = Math.max(write, v)
  }
  return { read: Math.min(1, read), write: Math.min(1, write) }
}

// Render a heat pair into a left-edge wash: reads on a cool channel, writes on a warm channel.
// Both present → a split bar (warm outer, cool inner ring) so the two are visually distinct.
function heatStyle(h) {
  const read = h.read
  const write = h.write
  if (read < HEAT_EPSILON && write < HEAT_EPSILON) return ''
  const readCol =
    getComputedStyle(document.documentElement).getPropertyValue('--wx-read') || '#3a7bd5'
  const writeCol =
    getComputedStyle(document.documentElement).getPropertyValue('--wx-write') || '#e0913a'
  // A row-background wash whose width encodes the dominant heat and color encodes kind.
  const layers = []
  if (write >= HEAT_EPSILON) {
    layers.push(`linear-gradient(90deg, ${writeCol.trim()} 0 3px, transparent 3px)`)
  }
  if (read >= HEAT_EPSILON) {
    const off = write >= HEAT_EPSILON ? '3px' : '0'
    const end = write >= HEAT_EPSILON ? '6px' : '3px'
    layers.push(
      `linear-gradient(90deg, transparent ${off}, ${readCol.trim()} ${off}, ${readCol.trim()} ${end}, transparent ${end})`
    )
  }
  const opacity = Math.min(1, Math.max(read, write) * 0.9 + 0.15)
  return `background:${layers.join(',')};opacity:${opacity};width:100%`
}

// =====================================================================================
// Tree listing (lazy, one level per fs.list call — spec §6)
// =====================================================================================
async function listDir(dirPath) {
  let res
  try {
    res = await atelier.fs.list(dirPath || '')
  } catch (err) {
    // A rejected fs.list must surface as an in-tree error row, not an unhandled
    // rejection that leaves a silently blank pane (the agent-flow dead-pane lesson).
    return { error: (err && err.message) || 'listing failed' }
  }
  if (!res || 'error' in res) {
    return { error: (res && res.error) || 'listing failed' }
  }
  const entries = (res.entries || []).slice().sort((a, b) => {
    // dirs first, then case-insensitive name; ignored sink below their peers
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  return { entries, truncated: !!res.truncated }
}

async function ensureListed(dirPath) {
  const node = state.nodes.get(dirPath)
  if (node && node.childrenLoaded) return node
  const r = await listDir(dirPath)
  const rec = state.nodes.get(dirPath) || { name: baseName(dirPath), kind: 'dir', ignored: false }
  rec.childrenLoaded = !r.error
  rec.entries = r.error ? [] : r.entries
  rec.truncated = r.truncated
  rec.error = r.error || null
  state.nodes.set(dirPath, rec)
  // Cache child metadata so heat/preview lookups don't need a re-list.
  if (!r.error) {
    for (const e of r.entries) {
      const cp = joinRel(dirPath, e.name)
      const existing = state.nodes.get(cp) || {}
      state.nodes.set(cp, {
        ...existing,
        name: e.name,
        kind: e.kind,
        ignored: e.ignored,
        size: e.size
      })
    }
  }
  return rec
}

// =====================================================================================
// Rendering
// =====================================================================================
const treeEl = $('tree')

function fmtSize(n) {
  if (typeof n !== 'number' || !isFinite(n)) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

const INDENT_PX = 14 // per-level indent (padding-based so hover/selection spans full width)

// Render a single directory's children into `container`. Recurses into expanded dirs.
function renderChildren(dirPath, container, now, depth) {
  depth = depth || 0
  const node = state.nodes.get(dirPath)
  container.textContent = ''
  if (depth > 0) {
    // Faint vertical guide aligned under the parent's twisty.
    container.style.background =
      'linear-gradient(var(--wx-guide, #222835), var(--wx-guide, #222835)) no-repeat'
    container.style.backgroundSize = '1px 100%'
    container.style.backgroundPosition = 5 + (depth - 1) * INDENT_PX + 13 + 'px 0'
  }
  const notePad = 32 + depth * INDENT_PX + 'px'
  if (!node || node.error) {
    const err = document.createElement('div')
    err.className = 'err-note'
    err.style.paddingLeft = notePad
    err.textContent = node && node.error ? node.error : 'not listed'
    container.appendChild(err)
    return
  }
  const entries = node.entries || []
  const visible = state.hideIgnored ? entries.filter((e) => !e.ignored) : entries
  if (!visible.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-note'
    empty.style.paddingLeft = notePad
    empty.textContent = node.truncated ? '(truncated)' : 'empty'
    container.appendChild(empty)
    return
  }
  for (const e of visible) {
    const path = joinRel(dirPath, e.name)
    container.appendChild(renderRow(path, e, now, depth))
  }
  if (node.truncated) {
    const t = document.createElement('div')
    t.className = 'empty-note'
    t.style.paddingLeft = notePad
    t.textContent = '(more entries — truncated at 5000)'
    container.appendChild(t)
  }
}

function renderRow(path, entry, now, depth) {
  const wrap = document.createElement('div')

  const row = document.createElement('div')
  row.className =
    'row' + (entry.ignored ? ' ignored' : '') + (state.selected === path ? ' selected' : '')
  row.dataset.path = path
  row.dataset.kind = entry.kind
  row.style.paddingLeft = 5 + (depth || 0) * INDENT_PX + 'px'

  const isDir = entry.kind === 'dir'
  const isOpen = isDir && state.expanded.has(path)

  // Heat wash (files: own heat; dirs: rollup so collapsed activity still shows).
  const h = isDir ? rollupHeatFor(path, now) : heatFor(path, now)
  const hStyle = heatStyle(h)
  if (hStyle) {
    const heat = document.createElement('div')
    heat.className = 'heat'
    heat.setAttribute('style', hStyle)
    row.appendChild(heat)
  }

  const twisty = document.createElement('span')
  twisty.className = 'twisty' + (isDir ? (isOpen ? ' open' : '') : ' leaf')
  twisty.textContent = '▶'
  row.appendChild(twisty)

  const icon = document.createElement('span')
  icon.innerHTML = window.WXIcons.iconFor(entry.name, entry.kind, isOpen)
  row.appendChild(icon.firstChild)

  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = entry.name
  row.appendChild(name)

  if (!isDir && typeof entry.size === 'number') {
    const badge = document.createElement('span')
    badge.className = 'badge size'
    badge.textContent = fmtSize(entry.size)
    row.appendChild(badge)
  }

  // Hover title: heat detail (spec §2 — "read 3× · wrote 1× · last 12s ago").
  if (!isDir) {
    const fh = h
    if (fh.readCount || fh.writeCount) {
      const ago = fh.last ? Math.round((now - fh.last) / 1000) : 0
      const parts = []
      if (fh.readCount) parts.push('read ' + fh.readCount + '×')
      if (fh.writeCount) parts.push('wrote ' + fh.writeCount + '×')
      parts.push('last ' + ago + 's ago')
      row.title = parts.join(' · ')
    }
  }

  wrap.appendChild(row)

  if (isDir && isOpen) {
    const children = document.createElement('div')
    children.className = 'children'
    children.dataset.for = path
    renderChildren(path, children, now, (depth || 0) + 1)
    wrap.appendChild(children)
  }

  return wrap
}

// Full re-render of the tree from the root node. Cheap: only expanded dirs have DOM.
function renderTree() {
  const now = Date.now()
  renderChildren('', treeEl, now, 0)
}

// A lighter re-render for pure heat updates: re-computes heat styles + titles without rebuilding
// the DOM structure (keeps scroll position and avoids thrash on the decay tick).
function refreshHeat() {
  const now = Date.now()
  const rows = treeEl.querySelectorAll('.row')
  for (const row of rows) {
    const path = row.dataset.path
    const isDir = row.dataset.kind === 'dir'
    const h = isDir ? rollupHeatFor(path, now) : heatFor(path, now)
    let heatEl = row.querySelector('.heat')
    const style = heatStyle(h)
    if (style) {
      if (!heatEl) {
        heatEl = document.createElement('div')
        heatEl.className = 'heat'
        row.insertBefore(heatEl, row.firstChild)
      }
      heatEl.setAttribute('style', style)
    } else if (heatEl) {
      heatEl.remove()
    }
    if (!isDir && (h.readCount || h.writeCount)) {
      const ago = h.last ? Math.round((now - h.last) / 1000) : 0
      const parts = []
      if (h.readCount) parts.push('read ' + h.readCount + '×')
      if (h.writeCount) parts.push('wrote ' + h.writeCount + '×')
      parts.push('last ' + ago + 's ago')
      row.title = parts.join(' · ')
    }
  }
}

// =====================================================================================
// Tree interaction
// =====================================================================================
async function toggleDir(path) {
  if (state.expanded.has(path)) {
    state.expanded.delete(path)
  } else {
    state.expanded.add(path)
    await ensureListed(path)
  }
  persistExpanded()
  renderTree()
}

treeEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row')
  if (!row) return
  const path = row.dataset.path
  if (row.dataset.kind === 'dir') {
    void toggleDir(path)
  } else {
    selectFile(path)
  }
})

treeEl.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row')
  if (!row || row.dataset.kind !== 'file') return
  void openExternally(row.dataset.path)
})

treeEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row')
  if (!row) return
  e.preventDefault()
  showContextMenu(row.dataset.path, row.dataset.kind, e.clientX, e.clientY)
})

// =====================================================================================
// Preview (file: DataBus tail + readAsset for images)
// =====================================================================================
const pvEl = $('preview')
const pvPath = $('pv-path')
const pvNote = $('pv-note')
const pvCode = $('pv-code')
const pvGutter = $('pv-gutter')
const pvText = $('pv-text')
const pvImg = $('pv-img')
const pvOpen = $('pv-open')
const pvRender = $('pv-render')
const pvModes = $('pv-modes')

// Preview modes per file type: markdown renders, JSON prettifies; both toggleable back
// to plain code. The chosen mode persists per extension (storage 'pvMode:<ext>').
function extOf(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? m[1].toLowerCase() : ''
}

function modesFor(path) {
  const ext = extOf(path)
  if (ext === 'md' || ext === 'markdown') return ['rendered', 'code']
  if (ext === 'json' || ext === 'jsonc') return ['pretty', 'code']
  return ['code']
}

function renderModeButtons(path) {
  pvModes.textContent = ''
  const modes = modesFor(path)
  if (modes.length < 2) return
  for (const m of modes) {
    const btn = document.createElement('button')
    btn.textContent = m
    btn.className = state.previewMode === m ? 'on' : ''
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      state.previewMode = m
      atelier.storage.set('pvMode:' + extOf(path), m).catch(() => {})
      renderModeButtons(path)
      renderPreview(path)
    })
    pvModes.appendChild(btn)
  }
}

function dropPreviewChannel() {
  if (!state.previewChannel) return
  try {
    atelier.data.unsubscribe(state.previewChannel)
  } catch (_) {
    /* ignore */
  }
  state.previewChannel = null
}

function expandPreview() {
  state.previewCollapsed = false
  pvEl.classList.remove('collapsed')
}

function showPreviewNote(msg) {
  pvNote.textContent = msg
  pvNote.classList.remove('hidden')
  pvCode.classList.add('hidden')
  pvImg.classList.add('hidden')
  pvRender.classList.add('hidden')
}

function selectFile(path) {
  if (state.selected === path) {
    expandPreview()
    return
  }
  // Update selection highlight.
  const prev = treeEl.querySelector('.row.selected')
  if (prev) prev.classList.remove('selected')
  const row = treeEl.querySelector('.row[data-path="' + cssEscape(path) + '"]')
  if (row) row.classList.add('selected')

  state.selected = path
  state.previewRaw = null
  dropPreviewChannel()
  expandPreview()
  pvPath.textContent = path
  pvOpen.classList.remove('hidden')

  // Restore the persisted mode for this extension (default: first applicable).
  const modes = modesFor(path)
  state.previewMode = modes[0]
  renderModeButtons(path)
  if (modes.length > 1) {
    atelier.storage
      .get('pvMode:' + extOf(path))
      .then((m) => {
        if (state.selected !== path) return
        if (typeof m === 'string' && modes.includes(m) && m !== state.previewMode) {
          state.previewMode = m
          renderModeButtons(path)
          if (state.previewRaw != null) renderPreview(path)
        }
      })
      .catch(() => {})
  }

  if (IMG_RE.test(path)) {
    pvModes.textContent = ''
    showPreviewNote('loading image…')
    atelier.data
      .readAsset(path)
      .then((r) => {
        if (state.selected !== path) return
        if (r && r.dataUrl) {
          pvImg.src = r.dataUrl
          pvImg.classList.remove('hidden')
          pvNote.classList.add('hidden')
          pvCode.classList.add('hidden')
        } else {
          showPreviewNote('could not load image: ' + ((r && r.error) || 'unknown'))
        }
      })
      .catch((err) => {
        if (state.selected === path) showPreviewNote('image error: ' + (err && err.message))
      })
    return
  }

  showPreviewNote('loading…')
  const channel = 'file:' + path
  state.previewChannel = channel
  atelier.data
    .subscribe(channel, (data) => {
      if (state.selected !== path) return
      if (data && typeof data === 'object' && 'error' in data) {
        showPreviewNote('could not read: ' + String(data.error))
        return
      }
      renderText(path, typeof data === 'string' ? data : String(data))
    })
    .catch((err) => {
      if (state.selected === path) showPreviewNote('read failed: ' + (err && err.message))
    })
}

// New content arrived (subscribe or live tail): stash the raw text, render in current mode.
function renderText(path, raw) {
  state.previewRaw = raw
  renderPreview(path)
}

// Render state.previewRaw per the active preview mode. Truncates large files.
function renderPreview(path) {
  let text = state.previewRaw == null ? '' : state.previewRaw
  let truncated = false
  // Byte-ish cap (chars ~ bytes for ASCII; fine as a bound).
  if (text.length > PREVIEW_MAX_BYTES) {
    text = text.slice(0, PREVIEW_MAX_BYTES)
    truncated = true
  }

  const old = pvCode.parentElement.querySelector('.trunc-marker')
  if (old) old.remove()
  let note = truncated
    ? 'showing first ' + Math.round(PREVIEW_MAX_BYTES / 1024) + ' KB — open externally for the rest'
    : null

  if (state.previewMode === 'rendered') {
    pvRender.innerHTML = window.WXMd.render(text)
    pvNote.classList.add('hidden')
    pvImg.classList.add('hidden')
    pvCode.classList.add('hidden')
    pvRender.classList.remove('hidden')
    if (note) appendTrunc(note, pvRender)
    return
  }

  let code = text
  let lang = path
  if (state.previewMode === 'pretty') {
    try {
      code = JSON.stringify(JSON.parse(text), null, 2)
      lang = path.replace(/\.[a-z0-9]+$/i, '.json')
    } catch (err) {
      note = 'not valid JSON (' + (err && err.message) + ') — showing raw'
    }
  }

  const lines = code.split('\n')
  pvGutter.textContent = lines.map((_, i) => i + 1).join('\n')
  pvText.innerHTML = highlight(code, lang)
  if (note) appendTrunc(note, pvCode)

  pvNote.classList.add('hidden')
  pvImg.classList.add('hidden')
  pvRender.classList.add('hidden')
  pvCode.classList.remove('hidden')
}

function appendTrunc(text, afterEl) {
  const m = document.createElement('div')
  m.className = 'trunc-marker'
  m.textContent = text
  afterEl.after(m)
}

pvOpen.addEventListener('click', (e) => {
  e.stopPropagation()
  if (state.selected) void openExternally(state.selected)
})

$('pv-head').addEventListener('click', () => {
  state.previewCollapsed = !state.previewCollapsed
  pvEl.classList.toggle('collapsed', state.previewCollapsed)
})

// =====================================================================================
// Lightweight syntax highlight (hand-rolled: comments / strings / keywords / numbers).
// Deliberately not a full parser — see DECISIONS.md. Escapes HTML first, then wraps tokens.
// =====================================================================================
const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'class',
  'extends',
  'new',
  'this',
  'super',
  'import',
  'export',
  'from',
  'default',
  'async',
  'await',
  'yield',
  'try',
  'catch',
  'finally',
  'throw',
  'typeof',
  'instanceof',
  'in',
  'of',
  'void',
  'delete',
  'null',
  'undefined',
  'true',
  'false',
  'def',
  'elif',
  'lambda',
  'pass',
  'raise',
  'with',
  'as',
  'and',
  'or',
  'not',
  'None',
  'True',
  'False',
  'self',
  'fn',
  'let',
  'mut',
  'pub',
  'struct',
  'enum',
  'impl',
  'trait',
  'match',
  'use',
  'type',
  'interface',
  'public',
  'private',
  'protected',
  'static',
  'final',
  'package',
  'func',
  'go',
  'defer',
  'range',
  'map',
  'string',
  'int',
  'bool',
  'float'
])

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlight(text, path) {
  const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1] || ''
  // Only attempt highlight for code-ish extensions; everything else is plain (still escaped).
  const codeLike =
    /^(js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|c|h|cpp|cc|hpp|cs|json|css|sh|rb|php|sql|yaml|yml|toml)$/i
  if (!codeLike.test(ext)) return escHtml(text)

  const lineComment = ext.match(/^(py|rb|sh|yaml|yml|toml)$/i) ? '#' : '//'
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    // Block comment (C-family)
    if (c === '/' && text[i + 1] === '*' && lineComment === '//') {
      let j = text.indexOf('*/', i + 2)
      if (j < 0) j = n
      else j += 2
      out += '<span class="tok-com">' + escHtml(text.slice(i, j)) + '</span>'
      i = j
      continue
    }
    // Line comment
    if (text.startsWith(lineComment, i)) {
      let j = text.indexOf('\n', i)
      if (j < 0) j = n
      out += '<span class="tok-com">' + escHtml(text.slice(i, j)) + '</span>'
      i = j
      continue
    }
    // String
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n && text[j] !== quote) {
        if (text[j] === '\\') j++
        j++
      }
      j = Math.min(j + 1, n)
      out += '<span class="tok-str">' + escHtml(text.slice(i, j)) + '</span>'
      i = j
      continue
    }
    // Number
    if (/[0-9]/.test(c) && !/[a-zA-Z_]/.test(text[i - 1] || '')) {
      let j = i
      while (j < n && /[0-9a-fA-FxX._]/.test(text[j])) j++
      out += '<span class="tok-num">' + escHtml(text.slice(i, j)) + '</span>'
      i = j
      continue
    }
    // Word (keyword?)
    if (/[a-zA-Z_$]/.test(c)) {
      let j = i
      while (j < n && /[a-zA-Z0-9_$]/.test(text[j])) j++
      const word = text.slice(i, j)
      if (KEYWORDS.has(word)) out += '<span class="tok-kw">' + word + '</span>'
      else out += escHtml(word)
      i = j
      continue
    }
    out += escHtml(c)
    i++
  }
  return out
}

// =====================================================================================
// Open in editor + mention in chat
// =====================================================================================
async function openExternally(path) {
  try {
    const r = await atelier.shell.openPath(path)
    if (r && r.error) toast('Could not open: ' + r.error)
  } catch (err) {
    toast('Open failed: ' + (err && err.message ? err.message : String(err)))
  }
}

async function mentionInChat(path) {
  const snippet = '`' + path + '`'
  try {
    const r = await atelier.agent.compose(snippet)
    if (r && r.error) {
      await clipboardFallback(snippet, r.error)
    } else {
      toast('Mentioned ' + path + ' in chat')
    }
  } catch (err) {
    await clipboardFallback(snippet, err && err.message)
  }
}

async function clipboardFallback(text, why) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Composer unavailable (' + (why || 'not open') + ') — path copied to clipboard')
  } catch (_) {
    toast('Composer unavailable — could not copy either')
  }
}

// =====================================================================================
// Context menu
// =====================================================================================
const ctxEl = $('ctx')
let ctxPath = null

function showContextMenu(path, kind, x, y) {
  ctxPath = path
  ctxEl.textContent = ''
  const items = [{ label: 'Mention in chat', act: () => mentionInChat(path) }]
  if (kind === 'file') {
    items.push({ label: 'Open in editor', act: () => openExternally(path) })
    items.push({ label: 'Preview', act: () => selectFile(path) })
  }
  items.push({ label: 'Copy path', act: () => copyPath(path) })
  for (const it of items) {
    const el = document.createElement('div')
    el.className = 'item'
    el.textContent = it.label
    el.addEventListener('click', () => {
      hideContextMenu()
      void it.act()
    })
    ctxEl.appendChild(el)
  }
  ctxEl.style.left = Math.min(x, window.innerWidth - 170) + 'px'
  ctxEl.style.top = Math.min(y, window.innerHeight - 20 - items.length * 26) + 'px'
  ctxEl.classList.remove('hidden')
}

function hideContextMenu() {
  ctxEl.classList.add('hidden')
  ctxPath = null
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path)
    toast('Copied ' + path)
  } catch (_) {
    toast('Copy failed')
  }
}

document.addEventListener('click', (e) => {
  if (!ctxEl.contains(e.target)) hideContextMenu()
})
window.addEventListener('blur', hideContextMenu)

// =====================================================================================
// Toolbar
// =====================================================================================
$('btn-refresh').addEventListener('click', async () => {
  // Re-list every currently-expanded dir + the root.
  state.nodes.get('') && (state.nodes.get('').childrenLoaded = false)
  await ensureListed('')
  for (const d of state.expanded) {
    const node = state.nodes.get(d)
    if (node) node.childrenLoaded = false
    await ensureListed(d)
  }
  renderTree()
})

const btnHide = $('btn-hide-ignored')
btnHide.addEventListener('click', () => {
  state.hideIgnored = !state.hideIgnored
  btnHide.classList.toggle('on', state.hideIgnored)
  persistToggle()
  renderTree()
})

const btnFreeze = $('btn-freeze')
btnFreeze.addEventListener('click', () => {
  state.frozen = !state.frozen
  state.frozenAt = state.frozen ? Date.now() : null
  btnFreeze.classList.toggle('on', state.frozen)
  $('frozen-note').classList.toggle('hidden', !state.frozen)
  persistFrozen()
  refreshHeat()
})

$('btn-clear').addEventListener('click', () => {
  state.heat = []
  persistHeat()
  refreshHeat()
  toast('Heat cleared')
})

// =====================================================================================
// Agent activity → heat (spec §4b): backfill via agent.history on mount, live via onEvent.
// =====================================================================================
function classify(name) {
  if (WRITE_TOOLS.has(name)) return 'write'
  if (READ_TOOLS.has(name)) return 'read'
  return null
}

// Pull a cwd-relative path out of a tool_use input (SDK passes absolute file_path; Grep/Glob
// carry a `path` dir). Returns null when not a cwd file.
function pathFromInput(input) {
  if (!input || typeof input !== 'object') return null
  const p = input.file_path || input.path || input.notebook_path
  if (typeof p !== 'string') return null
  return toRel(p)
}

// Handle one tool_use event: record heat, and if it's a WRITE into an expanded dir, re-list that
// dir so a newly-created file appears (targeted re-list, spec §6c). Backfilled events skip re-list.
async function handleToolUse(ev, live) {
  if (!ev || ev.kind !== 'tool_use') return
  const kind = classify(ev.name)
  if (!kind) return
  const rel = pathFromInput(ev.input)
  if (rel == null) return
  recordActivity(rel, kind)

  if (live && kind === 'write') {
    const parent = dirOf(rel)
    if (parent === '' || state.expanded.has(parent)) {
      const node = state.nodes.get(parent)
      if (node) node.childrenLoaded = false
      await ensureListed(parent)
      renderTree()
      return
    }
  }
  refreshHeat()
}

async function backfillHeat() {
  try {
    const hist = await atelier.agent.history(1000)
    if (!Array.isArray(hist)) return
    for (const ev of hist) {
      if (!ev || ev.kind !== 'tool_use') continue
      const kind = classify(ev.name)
      if (!kind) continue
      const rel = pathFromInput(ev.input)
      if (rel == null) continue
      // Backfill records carry no true timestamp (history is normalized) — anchor them slightly in
      // the past so they read as "recent but cooling", not brand-new. Ordered oldest→newest.
      state.heat.push({ path: rel, kind, ts: Date.now() })
    }
    if (state.heat.length > HEAT_CAP) state.heat.splice(0, state.heat.length - HEAT_CAP)
    persistHeat()
  } catch (_) {
    /* history unavailable — live events still build heat */
  }
}

// =====================================================================================
// Decay tick — a single low-frequency interval re-computes decayed heat (no per-file timers).
// =====================================================================================
let decayTimer = null
function startDecayTick() {
  if (decayTimer) return
  decayTimer = setInterval(() => {
    if (state.frozen) return
    refreshHeat()
  }, 2000)
}

// =====================================================================================
// Utilities
// =====================================================================================
let toastTimer = null
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600)
}

// Minimal CSS attribute-selector escape for the path lookup (paths can contain quotes/brackets).
function cssEscape(s) {
  return s.replace(/["\\]/g, '\\$&')
}

// =====================================================================================
// Mount / restore
// =====================================================================================
async function mount() {
  await loadPersisted()

  // Apply toggle UI state.
  btnHide.classList.toggle('on', state.hideIgnored)
  if (state.frozen) {
    state.frozenAt = Date.now()
    btnFreeze.classList.add('on')
    $('frozen-note').classList.remove('hidden')
  }

  // Learn the cwd (for absolute→relative path normalization of agent events).
  try {
    const info = await atelier.agent.info()
    if (info && info.cwd) {
      state.cwd = info.cwd
      const title = normSlash(info.cwd).replace(/\/$/, '').split('/').pop() || 'workspace'
      $('root-title').textContent = title
      atelier.layout.setTitle('Explorer · ' + title).catch(() => {})
    }
  } catch (_) {
    /* no agent info — tree still lists via fs.list (cwd-relative) */
  }

  // Root + restore the persisted expansion set (re-list each open dir).
  await ensureListed('')
  for (const d of Array.from(state.expanded)) {
    // Guard: a persisted-open dir that no longer exists just stays absent.
    await ensureListed(d).catch(() => state.expanded.delete(d))
  }
  renderTree()

  // Heat: backfill from history, then live.
  await backfillHeat()
  refreshHeat()
  atelier.agent.onEvent((ev) => {
    void handleToolUse(ev, true)
  })

  startDecayTick()
}

let mounted = false
function mountOnce() {
  if (mounted) return
  mounted = true
  mount().catch((err) => {
    // Fail visible: whatever broke the mount, say so in the pane instead of a blank tree.
    const tree = document.getElementById('tree')
    if (tree && !tree.childNodes.length) {
      const e = document.createElement('div')
      e.className = 'err-note'
      e.textContent = 'explorer failed to mount: ' + ((err && err.message) || err)
      tree.appendChild(e)
    }
    toast('Explorer mount error: ' + ((err && err.message) || err))
  })
}

atelier.on('load', mountOnce)
atelier.on('reload', mountOnce)
atelier.on('unload', () => {
  dropPreviewChannel()
  if (decayTimer) clearInterval(decayTimer)
})
