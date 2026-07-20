/* ───────────────────────────────────────────────────────────────────────────
   Agent Flow — pane logic. Self-contained vanilla JS, no external resources.
   Four tabs over one service backend (git reader) + the agent event trace.

   Data sources:
     - Timeline: atelier.agent.history() (backfill) + atelier.agent.onEvent (live)   [agent:read]
     - Changes/History/Branches: atelier.backend.call(op, params)                     [service RPC]
     - Pushed refresh: atelier.data.subscribe('flow:status', …)                       [data:subscribe]
   Persisted (per-conversation) via atelier.storage: active tab, timeline filter, selected file.

   The backend returns { error:'not a git repository' } on a non-git cwd; each git tab then shows a
   friendly empty state instead of throwing.
   ─────────────────────────────────────────────────────────────────────────── */
;(function () {
  'use strict'

  var atelier = window.atelier

  /* ── DOM ───────────────────────────────────────────────────────────────── */
  var $ = function (sel) {
    return document.querySelector(sel)
  }
  var tabsEl = $('#tabs')
  var panels = {}
  ;['timeline', 'changes', 'history', 'branches'].forEach(function (t) {
    panels[t] = document.querySelector('.panel[data-panel="' + t + '"]')
  })
  var tlList = $('#tl-list')
  var chFiles = $('#ch-files')
  var chDiff = $('#ch-diff')
  var chFileTitle = $('#ch-file')
  var chBranch = $('#ch-branch')
  var chTurns = $('#ch-turns')
  var hiList = $('#hi-list')
  var hiDetail = $('#hi-detail')
  var hiTitle = $('#hi-title')
  var brList = $('#br-list')

  /* ── State ─────────────────────────────────────────────────────────────── */
  var state = {
    tab: 'timeline',
    filter: 'all',
    selectedFile: null,
    selectedStaged: false,
    selectedCommit: null
  }
  var sessionStart = Date.now() // pane-mount time; commits after this are "this session" (best-effort)
  var turns = [] // [{ id, events:[…], result, tokens }]
  var fileIndex = {} // path -> Set of turn indices that touched it (cross-link, §4)
  var collapsed = {} // turnId -> bool

  /* ── helpers ───────────────────────────────────────────────────────────── */
  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }
  function isErr(r) {
    return r && typeof r === 'object' && typeof r.error === 'string'
  }
  function fmtDur(ms) {
    if (ms == null) return ''
    if (ms < 1000) return ms + 'ms'
    return (ms / 1000).toFixed(1) + 's'
  }
  function short(s, n) {
    s = String(s == null ? '' : s)
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }
  function persist() {
    try {
      atelier.storage.set('ui', {
        tab: state.tab,
        filter: state.filter,
        selectedFile: state.selectedFile,
        selectedStaged: state.selectedStaged
      })
    } catch (e) {
      /* storage best-effort */
    }
  }

  /* ── backend RPC (with graceful non-git handling) ──────────────────────── */
  function rpc(op, params) {
    return atelier.backend.call(op, params).then(
      function (r) {
        return r
      },
      function (err) {
        return { error: (err && err.message) || 'backend unavailable' }
      }
    )
  }

  /* ── tabs ──────────────────────────────────────────────────────────────── */
  function setTab(tab) {
    state.tab = tab
    Object.keys(panels).forEach(function (t) {
      panels[t].classList.toggle('active', t === tab)
    })
    Array.prototype.forEach.call(tabsEl.children, function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab)
    })
    persist()
    // Refresh git tabs on focus (spec: tab focus is a Changes refresh trigger).
    if (tab === 'changes') refreshChanges()
    else if (tab === 'history') refreshHistory()
    else if (tab === 'branches') refreshBranches()
  }
  tabsEl.addEventListener('click', function (e) {
    var b = e.target.closest('.tab')
    if (b) setTab(b.getAttribute('data-tab'))
  })

  /* ═══════════════════════ TIMELINE ═══════════════════════════════════════ */
  // AgentEvents carry no turn ids; we segment turns by result boundaries: a new turn starts on the
  // first event after a 'result', and 'result'/'tokens' close the current turn's footer.
  var curTurn = null
  function ensureTurn() {
    if (!curTurn) {
      curTurn = {
        id: 't' + turns.length,
        index: turns.length,
        events: [],
        result: null,
        tokens: null
      }
      turns.push(curTurn)
    }
    return curTurn
  }
  function FILE_TOOLS() {
    return { Write: 1, Edit: 1, MultiEdit: 1, NotebookEdit: 1, str_replace_editor: 1 }
  }
  function toolFile(name, input) {
    if (!input || typeof input !== 'object') return null
    if (FILE_TOOLS()[name]) return input.file_path || input.path || input.filePath || null
    return null
  }
  function relPath(p) {
    if (!p) return p
    // Normalize to a cwd-relative-ish tail for cross-linking with git paths (best-effort).
    return String(p).replace(/\\/g, '/')
  }

  function ingest(ev) {
    if (!ev || typeof ev !== 'object') return
    var k = ev.kind
    if (k === 'result') {
      var t = ensureTurn()
      t.result = { costUsd: ev.costUsd, durationMs: ev.durationMs, isError: !!ev.isError }
      curTurn = null // next event opens a new turn
      return
    }
    if (k === 'tokens') {
      var tt = curTurn || (turns.length ? turns[turns.length - 1] : ensureTurn())
      tt.tokens = { output: ev.output, input: ev.input }
      return
    }
    if (k === 'status' || k === 'permission_resolved' || k === 'question_resolved') return
    if (k === 'permission_mode' || k === 'auto_resume' || k === 'background') return
    if (k === 'task_activity' || k === 'system_init') return
    var turn = ensureTurn()
    if (k === 'tool_use') {
      var fp = toolFile(ev.name, ev.input)
      var entry = {
        kind: 'tool',
        toolUseId: ev.toolUseId,
        name: ev.name,
        input: ev.input,
        file: fp ? relPath(fp) : null,
        ok: null,
        durationMs: null,
        startedAt: Date.now()
      }
      turn.events.push(entry)
      if (fp) {
        var rp = relPath(fp)
        if (!fileIndex[rp]) fileIndex[rp] = {}
        fileIndex[rp][turn.index] = 1
      }
    } else if (k === 'tool_result') {
      // attach to the matching tool_use in any open/last turn
      var found = findTool(ev.toolUseId)
      if (found) {
        found.ok = !!ev.ok
        found.durationMs = Date.now() - (found.startedAt || Date.now())
        found.output = ev.output
      }
    } else if (k === 'text') {
      // Coalesce consecutive text deltas into one snippet entry.
      var last = turn.events[turn.events.length - 1]
      if (last && last.kind === 'text' && last.messageId === ev.messageId) last.text += ev.delta
      else turn.events.push({ kind: 'text', messageId: ev.messageId, text: ev.delta || '' })
    } else if (k === 'thinking') {
      /* omit thinking from the timeline to keep it about actions */
    } else if (k === 'permission_request') {
      turn.events.push({ kind: 'block', block: 'permission', title: ev.title || ev.toolName })
    } else if (k === 'question_request') {
      turn.events.push({ kind: 'block', block: 'question', title: 'Question for you' })
    } else if (k === 'error') {
      turn.events.push({ kind: 'error', text: ev.message || 'error' })
    }
  }
  function findTool(toolUseId) {
    for (var i = turns.length - 1; i >= 0; i--) {
      var evs = turns[i].events
      for (var j = evs.length - 1; j >= 0; j--) {
        if (evs[j].kind === 'tool' && evs[j].toolUseId === toolUseId) return evs[j]
      }
    }
    return null
  }

  // One-line summary for a tool call (name + a short input hint).
  function toolSummary(name, input, file) {
    if (file) return file
    if (!input || typeof input !== 'object') return ''
    if (name === 'Bash') return short(input.command || '', 80)
    if (name === 'Read') return input.file_path || input.path || ''
    if (name === 'Grep' || name === 'Glob') return short(input.pattern || input.query || '', 60)
    if (name === 'Task') return short(input.description || '', 60)
    try {
      return short(JSON.stringify(input), 70)
    } catch (e) {
      return ''
    }
  }

  function passesFilter(entry) {
    if (state.filter === 'all') return true
    if (state.filter === 'tools') return entry.kind === 'tool'
    if (state.filter === 'files') return entry.kind === 'tool' && !!entry.file
    if (state.filter === 'errors')
      return entry.kind === 'error' || (entry.kind === 'tool' && entry.ok === false)
    return true
  }

  function renderTimeline() {
    clear(tlList)
    if (!turns.length) {
      tlList.appendChild(el('div', 'pane-empty', 'No agent activity yet in this conversation.'))
      return
    }
    turns.forEach(function (turn) {
      var visible = turn.events.filter(passesFilter)
      if (!visible.length && state.filter !== 'all') return
      var wrap = el('div', 'turn' + (collapsed[turn.id] ? ' collapsed' : ''))
      var head = el('div', 'turn-head')
      head.appendChild(el('span', 'turn-caret', collapsed[turn.id] ? '▸' : '▾'))
      head.appendChild(el('span', 'turn-title', 'Turn ' + (turn.index + 1)))
      var meta = el('span', 'turn-meta')
      if (turn.result) {
        var bits = []
        if (turn.result.durationMs != null) bits.push(fmtDur(turn.result.durationMs))
        if (turn.tokens && turn.tokens.output != null) bits.push(turn.tokens.output + ' tok')
        if (turn.result.costUsd != null) bits.push('$' + turn.result.costUsd.toFixed(4))
        if (turn.result.isError) bits.push('error')
        meta.textContent = bits.join(' · ')
      } else if (turn.tokens && turn.tokens.output != null) {
        meta.textContent = turn.tokens.output + ' tok'
      }
      head.appendChild(meta)
      head.addEventListener('click', function () {
        collapsed[turn.id] = !collapsed[turn.id]
        renderTimeline()
      })
      wrap.appendChild(head)

      var body = el('div', 'turn-body')
      ;(state.filter === 'all' ? turn.events : visible).forEach(function (entry) {
        if (state.filter !== 'all' && !passesFilter(entry)) return
        body.appendChild(renderEntry(entry))
      })
      wrap.appendChild(body)
      tlList.appendChild(wrap)
    })
  }

  function renderEntry(entry) {
    if (entry.kind === 'text') {
      var row = el('div', 'ev text')
      row.appendChild(el('span', 'summary', short(entry.text.trim(), 200)))
      return row
    }
    if (entry.kind === 'error') {
      var er = el('div', 'ev err')
      er.appendChild(el('span', 'tool', 'error'))
      er.appendChild(el('span', 'summary', short(entry.text, 200)))
      return er
    }
    if (entry.kind === 'block') {
      var br = el('div', 'ev block')
      br.appendChild(
        el(
          'span',
          'summary',
          (entry.block === 'permission' ? '⚑ permission: ' : '❓ ') + short(entry.title, 120)
        )
      )
      return br
    }
    // tool
    var r = el('div', 'ev' + (entry.ok === false ? ' err' : ''))
    r.appendChild(el('span', 'tool', entry.name))
    r.appendChild(el('span', 'summary', toolSummary(entry.name, entry.input, entry.file)))
    if (entry.durationMs != null) r.appendChild(el('span', 'dur', fmtDur(entry.durationMs)))
    if (entry.file) {
      var vd = el('span', 'viewdiff', 'view diff')
      var f = entry.file
      vd.addEventListener('click', function () {
        openFileInChanges(f)
      })
      r.appendChild(vd)
    }
    return r
  }

  // Cross-link: Timeline "view diff" → Changes tab, file selected. Match a git-status path by suffix.
  function openFileInChanges(file) {
    setTab('changes')
    pendingSelectFile = file
    refreshChanges()
  }
  var pendingSelectFile = null

  // Filter chips
  $('#tl-filters').addEventListener('click', function (e) {
    var c = e.target.closest('.chip')
    if (!c) return
    state.filter = c.getAttribute('data-filter')
    Array.prototype.forEach.call(this.children, function (b) {
      b.classList.toggle('active', b === c)
    })
    persist()
    renderTimeline()
  })

  /* ═══════════════════════ CHANGES ════════════════════════════════════════ */
  var lastStatus = null
  function refreshChanges() {
    rpc('status').then(function (r) {
      renderChanges(r)
    })
  }
  function renderChanges(status) {
    lastStatus = status
    clear(chFiles)
    if (isErr(status)) {
      chBranch.textContent = '—'
      chFiles.appendChild(paneEmpty(status.error))
      clear(chDiff)
      return
    }
    chBranch.textContent = status.branch
      ? status.branch +
        (status.ahead || status.behind ? ' ↑' + status.ahead + ' ↓' + status.behind : '')
      : '(detached)'
    var groups = [
      ['Staged', status.staged || [], true],
      ['Unstaged', status.unstaged || [], false],
      [
        'Untracked',
        (status.untracked || []).map(function (u) {
          return { path: u.path, status: '?' }
        }),
        false
      ],
      [
        'Conflicted',
        (status.conflicted || []).map(function (c) {
          return { path: c.path, status: 'U' }
        }),
        false
      ]
    ]
    var any = false
    groups.forEach(function (g) {
      var label = g[0]
      var items = g[1]
      var staged = g[2]
      if (!items.length) return
      any = true
      chFiles.appendChild(el('div', 'group-label', label + ' (' + items.length + ')'))
      items.forEach(function (it) {
        chFiles.appendChild(fileRow(it, staged))
      })
    })
    if (!any) chFiles.appendChild(paneEmpty('Working tree clean.'))

    // Honor a pending cross-link selection, else re-select the persisted file if still present.
    var want = pendingSelectFile || state.selectedFile
    pendingSelectFile = null
    if (want) selectFileBySuffix(want)
  }

  function fileRow(it, staged) {
    var row = el('div', 'file-row')
    var st = (it.status || '?').toUpperCase()
    row.appendChild(el('span', 'st ' + st, st))
    var fp = el('span', 'fp', it.path)
    fp.setAttribute('title', it.path)
    row.appendChild(fp)
    // Cross-link chip: how many recent turns touched this file (§4).
    var idx = fileIndex[relPath(it.path)]
    var n = idx ? Object.keys(idx).length : 0
    if (n > 0) {
      var chip = el('span', 'turns-chip', n + ' turn' + (n > 1 ? 's' : ''))
      chip.setAttribute('title', 'Show timeline entries touching this file')
      chip.addEventListener('click', function (e) {
        e.stopPropagation()
        showTurnsForFile(it.path)
      })
      row.appendChild(chip)
    }
    row.dataset.path = it.path
    row.dataset.staged = staged ? '1' : ''
    row.addEventListener('click', function () {
      selectFile(it.path, staged, row)
    })
    return row
  }

  function selectFile(path, staged, row) {
    state.selectedFile = path
    state.selectedStaged = staged
    persist()
    Array.prototype.forEach.call(chFiles.querySelectorAll('.file-row'), function (r) {
      r.classList.toggle('selected', r === row)
    })
    chFileTitle.textContent = path
    var idx = fileIndex[relPath(path)]
    var n = idx ? Object.keys(idx).length : 0
    chTurns.textContent = n ? n + ' turn' + (n > 1 ? 's' : '') + ' touched this' : ''
    clear(chDiff)
    chDiff.appendChild(el('div', 'pane-empty', 'Loading diff…'))
    rpc('diff', { file: path, staged: staged }).then(function (r) {
      renderDiff(chDiff, r)
    })
  }
  function selectFileBySuffix(want) {
    var w = relPath(want)
    var rows = chFiles.querySelectorAll('.file-row')
    for (var i = 0; i < rows.length; i++) {
      var p = relPath(rows[i].dataset.path)
      if (p === w || w.slice(-p.length) === p || p.slice(-w.length) === w) {
        rows[i].click()
        return
      }
    }
  }

  function renderDiff(target, r) {
    clear(target)
    if (isErr(r)) {
      target.appendChild(paneEmpty(r.error))
      return
    }
    if (r.binary) {
      target.appendChild(paneEmpty('Binary file — no text diff.'))
      return
    }
    if (!r.hunks || !r.hunks.length) {
      target.appendChild(paneEmpty('No changes to show.'))
      return
    }
    r.hunks.forEach(function (h) {
      target.appendChild(el('div', 'hunk-head', h.header))
      h.lines.forEach(function (ln) {
        var row = el('div', 'dl ' + ln.type)
        var no = el('span', 'no')
        no.textContent =
          ln.type === 'add'
            ? '' + (ln.newNo || '')
            : ln.type === 'del'
              ? '' + (ln.oldNo || '')
              : '' + (ln.newNo || '')
        row.appendChild(no)
        row.appendChild(el('span', 'tx', ln.text != null ? ln.text : ''))
        target.appendChild(row)
      })
    })
    if (r.truncated) target.appendChild(el('div', 'pane-empty', '… diff truncated at 500KB …'))
  }

  // Reverse cross-link: Changes turns-chip → Timeline filtered to entries touching this file.
  function showTurnsForFile(path) {
    setTab('timeline')
    // Expand all turns that touched the file; collapse others; keep filter but highlight scroll.
    var idx = fileIndex[relPath(path)] || {}
    turns.forEach(function (t) {
      collapsed[t.id] = !idx[t.index]
    })
    renderTimeline()
  }

  $('#ch-refresh').addEventListener('click', refreshChanges)

  /* ═══════════════════════ HISTORY ════════════════════════════════════════ */
  function refreshHistory() {
    rpc('log', { limit: 200 }).then(function (r) {
      renderHistory(r)
    })
  }
  function renderHistory(r) {
    clear(hiList)
    if (isErr(r)) {
      hiList.appendChild(paneEmpty(r.error))
      clear(hiDetail)
      return
    }
    var commits = r.commits || []
    if (!commits.length) {
      hiList.appendChild(paneEmpty('No commits.'))
      return
    }
    commits.forEach(function (c) {
      var inSession = c.date && Date.parse(c.date) >= sessionStart
      var row = el('div', 'commit-row' + (inSession ? ' session' : ''))
      var subj = el('div', 'commit-subj')
      subj.textContent = c.subject
      if (inSession) {
        var badge = el('span', 'session-badge', 'this session')
        subj.appendChild(document.createTextNode(' '))
        subj.appendChild(badge)
      }
      row.appendChild(subj)
      var meta = el('div', 'commit-meta')
      meta.appendChild(el('span', 'hash', c.short))
      meta.appendChild(el('span', 'author', c.author))
      meta.appendChild(el('span', 'date', (c.date || '').slice(0, 10)))
      row.appendChild(meta)
      row.addEventListener('click', function () {
        Array.prototype.forEach.call(hiList.querySelectorAll('.commit-row'), function (x) {
          x.classList.toggle('selected', x === row)
        })
        selectCommit(c.hash)
      })
      hiList.appendChild(row)
    })
  }
  function selectCommit(hash) {
    state.selectedCommit = hash
    hiTitle.textContent = short(hash, 10)
    clear(hiDetail)
    hiDetail.appendChild(el('div', 'pane-empty', 'Loading commit…'))
    rpc('commit', { hash: hash }).then(function (info) {
      clear(hiDetail)
      if (isErr(info)) {
        hiDetail.appendChild(paneEmpty(info.error))
        return
      }
      var c = info.commit
      if (c) {
        hiTitle.textContent = short(c.subject, 60)
        var head = el('div', 'commit-detail-head')
        head.appendChild(el('div', 'commit-subj', c.subject))
        var hm = el('div', 'commit-meta')
        hm.appendChild(el('span', 'hash', c.hash))
        hm.appendChild(el('span', 'author', c.author + ' <' + c.email + '>'))
        hm.appendChild(el('span', 'date', c.date))
        head.appendChild(hm)
        hiDetail.appendChild(head)
      }
      ;(info.files || []).forEach(function (f) {
        var row = el('div', 'file-row')
        var st = (f.status || '?').toUpperCase()
        row.appendChild(el('span', 'st ' + st, st))
        row.appendChild(el('span', 'fp', f.orig ? f.orig + ' → ' + f.path : f.path))
        hiDetail.appendChild(row)
      })
      // The commit's own diff, reusing the Changes renderer.
      var diffBox = el('div', 'diff')
      hiDetail.appendChild(diffBox)
      diffBox.appendChild(el('div', 'pane-empty', 'Loading diff…'))
      rpc('diff', { commit: hash }).then(function (d) {
        renderDiff(diffBox, d)
      })
    })
  }
  $('#hi-refresh').addEventListener('click', refreshHistory)

  /* ═══════════════════════ BRANCHES (read-only) ═══════════════════════════ */
  function refreshBranches() {
    rpc('branches').then(function (r) {
      renderBranches(r)
    })
  }
  function renderBranches(r) {
    clear(brList)
    if (isErr(r)) {
      brList.appendChild(paneEmpty(r.error))
      return
    }
    brList.appendChild(el('div', 'br-section-title', 'Branches'))
    ;(r.branches || []).forEach(function (b) {
      var row = el('div', 'br-row' + (b.current ? ' current' : ''))
      row.appendChild(el('span', 'br-name', (b.current ? '● ' : '') + b.name))
      if (b.upstream) {
        row.appendChild(el('span', 'br-track', '→ ' + b.upstream))
        if (b.ahead || b.behind) {
          var ab = el('span', 'br-ab')
          if (b.ahead) ab.appendChild(el('span', 'ahead', '↑' + b.ahead + ' '))
          if (b.behind) ab.appendChild(el('span', 'behind', '↓' + b.behind))
          row.appendChild(ab)
        }
      }
      row.appendChild(el('span', 'br-subj', b.subject || ''))
      brList.appendChild(row)
    })
    if (!(r.branches || []).length) brList.appendChild(paneEmpty('No branches.'))

    brList.appendChild(el('div', 'br-section-title', 'Worktrees'))
    ;(r.worktrees || []).forEach(function (w) {
      var row = el('div', 'wt-row')
      row.appendChild(
        el('span', 'br-name', w.branch || (w.detached ? '(detached)' : w.bare ? '(bare)' : '?'))
      )
      row.appendChild(el('span', 'br-subj', w.path))
      if (w.locked) row.appendChild(el('span', 'br-track', 'locked'))
      brList.appendChild(row)
    })
    if (!(r.worktrees || []).length) brList.appendChild(paneEmpty('No worktrees.'))
  }
  $('#br-refresh').addEventListener('click', refreshBranches)

  /* ── shared empty-state ────────────────────────────────────────────────── */
  function paneEmpty(msg) {
    if (msg === 'not a git repository')
      return el('div', 'pane-empty', 'This folder is not a git repository.')
    if (msg === 'git not found')
      return el('div', 'pane-empty', 'git is not installed or not on PATH.')
    return el('div', 'pane-empty', msg || 'Nothing to show.')
  }

  /* ═══════════════════════ WIRING ═════════════════════════════════════════ */
  // Live agent events: ingest + re-render the timeline; a file-touching tool triggers a Changes refresh.
  atelier.agent.onEvent(function (ev) {
    ingest(ev)
    if (state.tab === 'timeline') renderTimeline()
    if (ev && ev.kind === 'tool_result') {
      var t = findTool(ev.toolUseId)
      if (t && t.file && state.tab === 'changes') refreshChanges()
    }
  })

  // Pushed refresh from the backend's debounced flow:status timer.
  atelier.data.subscribe('flow:status', function (status) {
    if (state.tab === 'changes') renderChanges(status)
    else lastStatus = status // cache for when Changes is next shown
  })

  // Mount: restore UI state, backfill the timeline, show the last tab.
  var mounted = false
  function mount() {
    if (mounted) return // guard: 'load' hook + the direct call must not double-run
    mounted = true
    atelier.storage.get('ui').then(function (saved) {
      if (saved && typeof saved === 'object') {
        if (saved.tab) state.tab = saved.tab
        if (saved.filter) state.filter = saved.filter
        if (saved.selectedFile) state.selectedFile = saved.selectedFile
        state.selectedStaged = !!saved.selectedStaged
      }
      // reflect restored filter chip
      Array.prototype.forEach.call($('#tl-filters').children, function (b) {
        b.classList.toggle('active', b.getAttribute('data-filter') === state.filter)
      })
      // backfill timeline
      atelier.agent.history(1000).then(function (hist) {
        if (Array.isArray(hist)) hist.forEach(ingest)
        setTab(state.tab) // renders the active tab (and triggers its git refresh)
        if (state.tab !== 'timeline') renderTimeline()
      })
    })
  }

  atelier.on('load', mount)
  // If 'load' already fired before this script ran (fresh mount), run immediately.
  mount()
})()
