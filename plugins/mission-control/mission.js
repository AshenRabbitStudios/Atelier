// Mission Control — pane logic. A fold over this conversation's AgentEvent stream:
//   'background' snapshots  → running set (tasks lane + subagent fleet) + inbox diff
//   'task_activity'         → per-subagent latest-activity line
//   'status'                → working guard for nudges
//   bash:stdout frames      → commands lane (start/output/error; no exit codes today)
//   context 'work_summary'  → agent-maintained summary panel
// The only write is agent.send (templated nudges). Inbox persists in storage; a
// wholesale many→0 snapshot (rebind/registry clear) is suppressed, not turned into
// a flood of "finished" chips. Completion is shown as "finished", never "succeeded"
// (outcome is not in the feed — design §4).

const A = window.atelier
const $ = (id) => document.getElementById(id)

const INBOX_CAP = 20
const CMD_CAP = 20
const LONG_RUNNER_MS = 5 * 60 * 1000 // fleet rows older than this offer "check on it"

const state = {
  running: new Map(), // "<kind>:<id>" -> { id, kind, label, detail, startedAt }
  activity: new Map(), // taskId -> one-line latest activity
  inbox: [], // [{ label, kind, elapsedMs, at }] newest first
  cmds: [], // [{ toolUseId, command, state: 'live'|'ok'|'bad', at }] newest first
  working: false,
  seenSnapshot: false
}

/* ── persistence ── */
function persistInbox() {
  A.storage.set('inbox', state.inbox).catch(() => {})
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
function fmtElapsed(ms) {
  if (ms < 60e3) return Math.max(1, Math.round(ms / 1e3)) + 's'
  if (ms < 3600e3) return Math.round(ms / 60e3) + 'm'
  return (ms / 3600e3).toFixed(1) + 'h'
}
function short(s, n) {
  s = String(s == null ? '' : s)
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
function keyOf(t) {
  return t.kind + ':' + t.id
}

/* ── nudges (the board's only write) ── */
function nudgeButton(label, message) {
  const btn = el('button', 'mini', label)
  btn.addEventListener('click', async () => {
    btn.disabled = true
    const prev = btn.textContent
    try {
      await A.agent.send(message)
      btn.textContent = state.working ? 'queued ✓' : 'sent ✓'
    } catch (e) {
      btn.textContent = 'failed'
    }
    setTimeout(() => {
      btn.textContent = prev
      btn.disabled = false
    }, 2500) // debounce: absorb double-clicks / nudge storms
  })
  if (state.working) btn.title = 'The agent is mid-turn — the message will queue.'
  return btn
}

/* ── ingest: background snapshots ── */
function onSnapshot(tasks, live) {
  const next = new Map()
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || typeof t !== 'object' || !t.id) continue
    next.set(keyOf(t), t)
  }
  if (live && state.seenSnapshot) {
    const departed = []
    for (const [k, t] of state.running) {
      if (!next.has(k)) departed.push(t)
    }
    // Guard: a rebind clears the whole registry in one snapshot — that is "nothing
    // running now", not "everything just completed". Suppress the flood.
    const wholesaleClear = next.size === 0 && departed.length > 1
    if (!wholesaleClear) {
      const now = Date.now()
      for (const t of departed) {
        state.inbox.unshift({
          label: t.label || t.id,
          kind: t.kind,
          elapsedMs: t.startedAt ? now - t.startedAt : null,
          at: now
        })
      }
      if (departed.length) {
        state.inbox = state.inbox.slice(0, INBOX_CAP)
        persistInbox()
      }
    }
  }
  state.running = next
  state.seenSnapshot = true
  render()
}

/* ── ingest: agent events ── */
function onAgentEvent(ev) {
  if (!ev || typeof ev !== 'object') return
  if (ev.kind === 'background') {
    onSnapshot(ev.tasks, true)
  } else if (ev.kind === 'task_activity') {
    state.activity.set(ev.taskId, activityLine(ev.item))
    renderFleet()
  } else if (ev.kind === 'status') {
    state.working = ev.status === 'working'
    renderStatus()
  }
}

function activityLine(item) {
  if (!item || typeof item !== 'object') return ''
  if (item.kind === 'tool_use') return '⚙ ' + (item.name || 'tool')
  if (item.kind === 'tool_result')
    return (item.ok === false ? '✗ ' : '✓ ') + short(item.output || '', 60)
  if (item.kind === 'thinking') return '…thinking'
  if (item.kind === 'text') return short(String(item.text || '').trim(), 70)
  return ''
}

/* ── ingest: bash frames ── */
function onBashFrame(msg) {
  if (!msg || typeof msg !== 'object' || !msg.toolUseId) return
  if (msg.phase === 'start') {
    state.cmds.unshift({
      toolUseId: msg.toolUseId,
      command: msg.command || '',
      state: 'live',
      at: Date.now()
    })
    state.cmds = state.cmds.slice(0, CMD_CAP)
  } else {
    const c = state.cmds.find((x) => x.toolUseId === msg.toolUseId)
    // 'error' phase = the tool failed; 'output' = finished (no exit code in the tap —
    // label it done, not "exit 0").
    if (c) c.state = msg.phase === 'error' ? 'bad' : 'ok'
  }
  renderCmds()
}

/* ── render ── */
function render() {
  renderInbox()
  renderDone()
  renderProgress()
  renderFleet()
  renderCmds()
}

function renderStatus() {
  const s = $('conv-status')
  s.textContent = state.working ? '● working' : '○ idle'
  s.classList.toggle('working', state.working)
}

function renderInbox() {
  const host = $('inbox')
  clear(host)
  $('inbox-clear').classList.toggle('hidden', !state.inbox.length)
  for (const item of state.inbox) {
    const chip = el('span', 'inbox-chip')
    chip.appendChild(el('span', 'glyph', '✓'))
    chip.appendChild(
      el(
        'span',
        null,
        (item.kind === 'subagent' ? 'subagent ' : 'task ') +
          '“' +
          short(item.label, 40) +
          '” finished' +
          (item.elapsedMs != null ? ' · ' + fmtElapsed(item.elapsedMs) : '')
      )
    )
    chip.title = new Date(item.at).toLocaleTimeString()
    host.appendChild(chip)
  }
}

function runningOf(kind) {
  return [...state.running.values()].filter((t) => t.kind === kind)
}

function renderProgress() {
  const host = $('l-progress')
  clear(host)
  const tasks = runningOf('task')
  $('c-progress').textContent = tasks.length ? String(tasks.length) : ''
  if (!tasks.length) {
    host.appendChild(el('div', 'lane-empty', 'No tasks in flight.'))
    return
  }
  for (const t of tasks) {
    const card = el('div', 'card running')
    card.appendChild(el('div', 'card-label', t.label || t.id))
    const meta = el('div', 'card-meta')
    meta.appendChild(elapsedEl(t.startedAt))
    if (t.detail) meta.appendChild(el('span', null, short(t.detail, 50)))
    card.appendChild(meta)
    const nudges = el('div', 'nudges')
    nudges.appendChild(
      nudgeButton(
        'promote',
        'Please prioritize the task "' + short(t.label || t.id, 80) + '" next.'
      )
    )
    card.appendChild(nudges)
    host.appendChild(card)
  }
}

function renderFleet() {
  const host = $('l-fleet')
  clear(host)
  const fleet = runningOf('subagent')
  $('c-fleet').textContent = fleet.length ? String(fleet.length) : ''
  if (!fleet.length) {
    host.appendChild(el('div', 'lane-empty', 'No subagents running.'))
    return
  }
  for (const t of fleet) {
    const card = el('div', 'card running')
    card.appendChild(el('div', 'card-label', t.label || t.id))
    const meta = el('div', 'card-meta')
    meta.appendChild(elapsedEl(t.startedAt))
    card.appendChild(meta)
    const act = state.activity.get(t.id)
    if (act) card.appendChild(el('div', 'card-activity', act))
    if (t.startedAt && Date.now() - t.startedAt > LONG_RUNNER_MS) {
      const nudges = el('div', 'nudges')
      nudges.appendChild(
        nudgeButton(
          'check on it',
          'The subagent "' +
            short(t.label || t.id, 60) +
            '" has been running ' +
            fmtElapsed(Date.now() - t.startedAt) +
            '. Is it stuck? Consider checking, stopping, or redirecting it.'
        )
      )
      card.appendChild(nudges)
    }
    host.appendChild(card)
  }
}

function renderCmds() {
  const host = $('l-cmds')
  clear(host)
  $('c-cmds').textContent = state.cmds.length ? String(state.cmds.length) : ''
  if (!state.cmds.length) {
    host.appendChild(el('div', 'lane-empty', 'No shell commands yet.'))
    return
  }
  for (const c of state.cmds) {
    const card = el(
      'div',
      'card' + (c.state === 'bad' ? ' errorish' : c.state === 'live' ? ' running' : ' done')
    )
    const row = el('div', 'card-cmd', c.command || '(command)')
    row.title = c.command
    card.appendChild(row)
    const meta = el('div', 'card-meta')
    meta.appendChild(
      el(
        'span',
        'cmd-state ' + c.state,
        c.state === 'live' ? 'running' : c.state === 'bad' ? 'had errors' : 'done'
      )
    )
    meta.appendChild(el('span', null, new Date(c.at).toLocaleTimeString()))
    card.appendChild(meta)
    if (c.state === 'bad') {
      const nudges = el('div', 'nudges')
      nudges.appendChild(
        nudgeButton(
          'investigate',
          'The background command "' +
            short(c.command, 90) +
            '" reported errors. Please look into it.'
        )
      )
      card.appendChild(nudges)
    }
    host.appendChild(card)
  }
}

function renderDone() {
  const host = $('l-done')
  clear(host)
  const done = state.inbox
  $('c-done').textContent = done.length ? String(done.length) : ''
  if (!done.length) {
    host.appendChild(el('div', 'lane-empty', 'Nothing finished yet (while the pane was watching).'))
    return
  }
  for (const item of done) {
    const card = el('div', 'card done')
    card.appendChild(el('div', 'card-label', item.label))
    const meta = el('div', 'card-meta')
    meta.appendChild(el('span', null, item.kind))
    if (item.elapsedMs != null)
      meta.appendChild(el('span', null, 'ran ' + fmtElapsed(item.elapsedMs)))
    meta.appendChild(el('span', null, new Date(item.at).toLocaleTimeString()))
    card.appendChild(meta)
    host.appendChild(card)
  }
}

function elapsedEl(startedAt) {
  const e = el('span', 'elapsed', startedAt ? fmtElapsed(Date.now() - startedAt) : '')
  if (startedAt) e.dataset.start = String(startedAt)
  return e
}

// One 1s ticker updates every elapsed clock in place (no per-card timers).
setInterval(() => {
  document.querySelectorAll('.elapsed[data-start]').forEach((e) => {
    e.textContent = fmtElapsed(Date.now() - Number(e.dataset.start))
  })
}, 1000)

/* ── work summary panel ── */
async function refreshSummary() {
  try {
    const v = await A.context.get('work_summary')
    const body = $('summary-body')
    if (typeof v === 'string' && v.trim()) {
      body.textContent = v
    } else {
      body.textContent = 'No summary yet — the agent fills this in as work starts.'
    }
  } catch (e) {
    /* context unavailable (export not pinned) — leave the placeholder */
  }
}

/* ── mount ── */
let mounted = false
async function mount() {
  if (mounted) return
  mounted = true

  $('inbox-clear').addEventListener('click', () => {
    state.inbox = []
    persistInbox()
    renderInbox()
    renderDone()
  })

  try {
    const info = await A.agent.info()
    if (info) {
      $('conv-title').textContent = 'Mission Control · ' + (info.title || 'conversation')
      state.working = info.status === 'working'
    }
  } catch (e) {
    /* agent:read unavailable */
  }
  renderStatus()

  try {
    const saved = await A.storage.get('inbox')
    if (Array.isArray(saved)) state.inbox = saved.slice(0, INBOX_CAP)
  } catch (e) {
    /* first run */
  }

  // Backfill: take the LAST background snapshot in history as the current running set
  // (no inbox chips from history — those completions predate this mount and the
  // persisted inbox already covers what an open pane saw).
  try {
    const hist = await A.agent.history(1000)
    if (Array.isArray(hist)) {
      let lastSnapshot = null
      for (const ev of hist) {
        if (ev && ev.kind === 'background') lastSnapshot = ev.tasks
        else if (ev && ev.kind === 'task_activity')
          state.activity.set(ev.taskId, activityLine(ev.item))
      }
      if (lastSnapshot) onSnapshot(lastSnapshot, false)
    }
  } catch (e) {
    /* history unavailable — live events still build the board */
  }

  try {
    A.agent.onEvent(onAgentEvent)
  } catch (e) {
    /* agent:read unavailable */
  }
  try {
    await A.data.subscribe('bash:stdout', onBashFrame)
  } catch (e) {
    /* data:subscribe unavailable */
  }
  A.on('context', (p) => {
    if (p && p.key === 'work_summary') refreshSummary()
  })
  refreshSummary()

  render()
}

A.on('load', mount)
mount()
