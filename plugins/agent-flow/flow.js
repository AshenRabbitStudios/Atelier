/* ───────────────────────────────────────────────────────────────────────────
   Agent Flow — pane logic (2026-07-21 rework: git-first).

   Repo tab (primary): health strip + accordion navigator (working tree / history /
   branches & worktrees / stashes / submodules / CI) + a detail pane (diffs, commit
   details with full message + per-file diffs, stash diffs, CI runs). All git/gh data
   comes from the service backend over atelier.backend.call; read-only.

   Agent tab: a flat, exactly-ordered event log — every AgentEvent from
   atelier.agent.history (backfill) + atelier.agent.onEvent (live), rendered per a
   tiered verbosity slider:
     L1 turns    — results/errors only
     L2 tools    — + tool calls/results/tokens
     L3 all      — + text/thinking/permissions/questions/status/atelier events
     L4 raw      — L3, every row expandable to its raw JSON payload
   plus filter chips, substring search, and follow-scroll.

   Persisted (per-conversation) via atelier.storage key 'ui': active tab, verbosity
   level, filter, repo section collapse states, selected file.
   ─────────────────────────────────────────────────────────────────────────── */
;(function () {
  'use strict'

  var atelier = window.atelier

  /* ── DOM ───────────────────────────────────────────────────────────────── */
  var $ = function (sel) {
    return document.querySelector(sel)
  }
  var tabsEl = $('#tabs')
  var panels = {
    repo: document.querySelector('.panel[data-panel="repo"]'),
    agent: document.querySelector('.panel[data-panel="agent"]')
  }
  var healthEl = $('#health')
  var navEl = $('#repo-nav')
  var rdTitle = $('#rd-title')
  var rdMeta = $('#rd-meta')
  var rdBody = $('#rd-body')
  var agList = $('#ag-list')
  var agLevel = $('#ag-level')
  var agLevelName = $('#ag-level-name')
  var agSearch = $('#ag-search')
  var agPin = $('#ag-pin')

  /* ── State ─────────────────────────────────────────────────────────────── */
  var state = {
    tab: 'repo',
    level: 2, // agent verbosity L1–L4
    filter: 'all',
    search: '',
    follow: true,
    sections: {}, // repo nav section id -> collapsed?
    selectedFile: null,
    selectedStaged: false
  }
  var sessionStart = Date.now() // commits after this are "this session" (best-effort)
  var cwd = null // this conversation's cwd (worktree annotation)

  // Repo data caches (latest RPC results).
  var repo = {
    status: null,
    log: null,
    branches: null,
    stashes: null,
    submodules: null,
    ci: null,
    historySearch: ''
  }
  var ciTimer = null

  // Agent log: flat, ordered.
  var events = [] // [{ seq, ts, ev, text? (coalesced), open? }]
  var seqNo = 0
  var toolStarts = {} // toolUseId -> { entry, at }
  var fileIndex = {} // normalized path -> count of tool events touching it

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
  function relTime(iso) {
    var t = typeof iso === 'number' ? iso : Date.parse(iso || '')
    if (!isFinite(t)) return ''
    var d = Date.now() - t
    if (d < 60e3) return Math.max(1, Math.round(d / 1e3)) + 's ago'
    if (d < 3600e3) return Math.round(d / 60e3) + 'm ago'
    if (d < 86400e3) return Math.round(d / 3600e3) + 'h ago'
    return Math.round(d / 86400e3) + 'd ago'
  }
  function clock(ts) {
    if (!ts) return ''
    var d = new Date(ts)
    var p = function (n) {
      return (n < 10 ? '0' : '') + n
    }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }
  function normPath(p) {
    return String(p == null ? '' : p)
      .replace(/\\/g, '/')
      .toLowerCase()
  }
  function persist() {
    try {
      atelier.storage.set('ui', {
        tab: state.tab,
        level: state.level,
        filter: state.filter,
        sections: state.sections,
        selectedFile: state.selectedFile,
        selectedStaged: state.selectedStaged
      })
    } catch (e) {
      /* best-effort */
    }
  }
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
  function paneEmpty(msg) {
    if (msg === 'not a git repository')
      return el('div', 'pane-empty', 'This folder is not a git repository.')
    if (msg === 'git not found')
      return el('div', 'pane-empty', 'git is not installed or not on PATH.')
    return el('div', 'pane-empty', msg || 'Nothing to show.')
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
    if (tab === 'repo') {
      refreshRepo()
      startCiPoll()
    } else {
      stopCiPoll()
      renderAgent()
    }
  }
  tabsEl.addEventListener('click', function (e) {
    var b = e.target.closest('.tab')
    if (b) setTab(b.getAttribute('data-tab'))
  })

  /* ═══════════════════════ REPO ═══════════════════════════════════════════ */
  function refreshRepo() {
    rpc('status').then(function (r) {
      repo.status = r
      renderHealth()
      renderNav()
    })
    rpc('log', { limit: 200 }).then(function (r) {
      repo.log = r
      renderHealth()
      renderNav()
    })
    rpc('branches').then(function (r) {
      repo.branches = r
      renderHealth()
      renderNav()
    })
    rpc('stashes').then(function (r) {
      repo.stashes = r
      renderNav()
    })
    rpc('submodules').then(function (r) {
      repo.submodules = r
      renderNav()
    })
    refreshCi()
  }
  function refreshCi() {
    var branch = repo.status && !isErr(repo.status) ? repo.status.branch : null
    rpc('ci', branch ? { branch: branch } : {}).then(function (r) {
      repo.ci = r
      renderHealth()
      renderNav()
    })
  }
  function startCiPoll() {
    if (ciTimer) return
    ciTimer = setInterval(function () {
      if (state.tab === 'repo') refreshCi()
    }, 60000)
  }
  function stopCiPoll() {
    if (ciTimer) {
      clearInterval(ciTimer)
      ciTimer = null
    }
  }

  /* ── health strip ──────────────────────────────────────────────────────── */
  function renderHealth() {
    clear(healthEl)
    var s = repo.status
    if (isErr(s)) {
      healthEl.appendChild(
        el('span', 'seg', s.error === 'not a git repository' ? 'not a git repo' : s.error)
      )
      return
    }
    if (!s) return

    var br = seg(
      '⎇ ' +
        (s.branch || '(detached)') +
        (s.ahead || s.behind ? '  ↑' + s.ahead + ' ↓' + s.behind : ''),
      'branches',
      s.upstream ? 'tracking ' + s.upstream : 'no upstream'
    )
    healthEl.appendChild(br)

    var dirty =
      (s.staged || []).length +
      (s.unstaged || []).length +
      (s.untracked || []).length +
      (s.conflicted || []).length
    var d = seg(
      dirty ? '● ' + dirty + ' change' + (dirty > 1 ? 's' : '') : '✓ clean',
      'worktree',
      'working tree'
    )
    if ((s.conflicted || []).length) d.classList.add('bad')
    else if (dirty) d.classList.add('warn')
    else d.classList.add('good')
    healthEl.appendChild(d)

    var log = repo.log
    if (log && !isErr(log) && log.commits && log.commits.length) {
      healthEl.appendChild(
        seg(
          '◷ ' + relTime(log.commits[0].date),
          'history',
          'last commit: ' + log.commits[0].subject
        )
      )
    }

    // CI badge from the latest run on the current branch.
    var ci = repo.ci
    var ciSeg
    if (isErr(ci)) {
      ciSeg = seg('CI –', 'ci', ci.error)
    } else if (ci && ci.runs && ci.runs.length) {
      var run = ci.runs[0]
      var glyph = run.status === 'completed' ? (run.conclusion === 'success' ? '✓' : '✗') : '●'
      ciSeg = seg('CI ' + glyph, 'ci', run.name + ' — ' + (run.conclusion || run.status))
      ciSeg.classList.add(
        run.status !== 'completed' ? 'warn' : run.conclusion === 'success' ? 'good' : 'bad'
      )
    } else {
      ciSeg = seg('CI –', 'ci', 'no runs found')
    }
    healthEl.appendChild(ciSeg)

    var b = repo.branches
    if (b && !isErr(b) && (b.worktrees || []).length > 1) {
      healthEl.appendChild(
        seg(
          '⌂ ' + b.worktrees.length + ' worktrees',
          'worktrees',
          'parallel checkouts of this repo'
        )
      )
    }
  }
  function seg(text, sectionId, tip) {
    var e = el('span', 'seg', text)
    if (tip) e.title = tip
    e.addEventListener('click', function () {
      state.sections[sectionId === 'worktrees' ? 'branches' : sectionId] = false
      persist()
      renderNav()
      var sec = navEl.querySelector(
        '[data-section="' + (sectionId === 'worktrees' ? 'branches' : sectionId) + '"]'
      )
      if (sec) sec.scrollIntoView({ block: 'start' })
    })
    return e
  }

  /* ── navigator (accordion) ─────────────────────────────────────────────── */
  function renderNav() {
    clear(navEl)
    navEl.appendChild(buildWorktreeSection())
    navEl.appendChild(buildHistorySection())
    navEl.appendChild(buildBranchesSection())
    var st = buildStashSection()
    if (st) navEl.appendChild(st)
    var sm = buildSubmoduleSection()
    if (sm) navEl.appendChild(sm)
    navEl.appendChild(buildCiSection())
  }

  function section(id, title, count) {
    var sec = el('div', 'nav-sec')
    sec.dataset.section = id
    var head = el('div', 'nav-sec-head')
    head.appendChild(el('span', 'caret', state.sections[id] ? '▸' : '▾'))
    head.appendChild(el('span', 'nav-sec-title', title))
    if (count != null) head.appendChild(el('span', 'nav-sec-count', String(count)))
    head.addEventListener('click', function () {
      state.sections[id] = !state.sections[id]
      persist()
      renderNav()
    })
    sec.appendChild(head)
    var body = el('div', 'nav-sec-body')
    if (state.sections[id]) body.classList.add('hidden')
    sec.appendChild(body)
    return { sec: sec, body: body }
  }

  /* Working tree */
  function buildWorktreeSection() {
    var s = repo.status
    var dirty =
      !s || isErr(s)
        ? 0
        : (s.staged || []).length +
          (s.unstaged || []).length +
          (s.untracked || []).length +
          (s.conflicted || []).length
    var x = section('worktree', 'Working tree', dirty)
    if (!s) x.body.appendChild(paneEmpty('Loading…'))
    else if (isErr(s)) x.body.appendChild(paneEmpty(s.error))
    else {
      var groups = [
        ['Staged', s.staged || [], true],
        ['Unstaged', s.unstaged || [], false],
        [
          'Untracked',
          (s.untracked || []).map(function (u) {
            return { path: u.path, status: '?' }
          }),
          false
        ],
        [
          'Conflicted',
          (s.conflicted || []).map(function (c) {
            return { path: c.path, status: 'U' }
          }),
          false
        ]
      ]
      var any = false
      groups.forEach(function (g) {
        if (!g[1].length) return
        any = true
        x.body.appendChild(el('div', 'group-label', g[0] + ' (' + g[1].length + ')'))
        g[1].forEach(function (it) {
          x.body.appendChild(fileRow(it, g[2]))
        })
      })
      if (!any) x.body.appendChild(paneEmpty('Working tree clean.'))
    }
    return x.sec
  }

  function fileRow(it, staged) {
    var row = el('div', 'file-row')
    var st = (it.status || '?').toUpperCase()
    row.appendChild(el('span', 'st ' + st, st))
    var fp = el('span', 'fp', it.orig ? it.orig + ' → ' + it.path : it.path)
    fp.title = it.path
    row.appendChild(fp)
    var n = fileIndex[normPath(it.path)] || suffixTouches(it.path)
    if (n > 0) {
      var chip = el('span', 'turns-chip', n + '×')
      chip.title = 'The agent touched this file ' + n + ' time(s) — click to see those events'
      chip.addEventListener('click', function (e) {
        e.stopPropagation()
        showFileInAgent(it.path)
      })
      row.appendChild(chip)
    }
    if (state.selectedFile === it.path && state.selectedStaged === staged)
      row.classList.add('selected')
    row.addEventListener('click', function () {
      state.selectedFile = it.path
      state.selectedStaged = staged
      persist()
      Array.prototype.forEach.call(navEl.querySelectorAll('.file-row'), function (r) {
        r.classList.toggle('selected', r === row)
      })
      showFileDiff(it.path, staged)
    })
    return row
  }
  // Agent events carry absolute paths; git paths are repo-relative — match by suffix.
  function suffixTouches(gitPath) {
    var suffix = normPath(gitPath)
    var n = 0
    Object.keys(fileIndex).forEach(function (p) {
      if (p.length >= suffix.length && p.slice(-suffix.length) === suffix) n += fileIndex[p]
    })
    return n
  }

  function showFileDiff(path, staged) {
    rdTitle.textContent = path
    rdMeta.textContent = staged ? 'staged' : ''
    clear(rdBody)
    rdBody.appendChild(el('div', 'pane-empty', 'Loading diff…'))
    rpc('diff', { file: path, staged: staged }).then(function (r) {
      clear(rdBody)
      renderDiffInto(rdBody, r)
    })
  }

  /* History */
  function buildHistorySection() {
    var x = section('history', 'History', null)
    var log = repo.log
    var search = el('input', 'hist-search')
    search.type = 'text'
    search.placeholder = 'filter subject / author / hash…'
    search.value = repo.historySearch
    search.addEventListener('input', function () {
      repo.historySearch = search.value
      renderCommitList(list)
    })
    search.addEventListener('click', function (e) {
      e.stopPropagation()
    })
    x.body.appendChild(search)
    var list = el('div', 'commit-list')
    x.body.appendChild(list)
    if (!log) list.appendChild(paneEmpty('Loading…'))
    else if (isErr(log)) list.appendChild(paneEmpty(log.error))
    else renderCommitList(list)
    return x.sec
  }

  // Simple lane assignment for the graph gutter: newest-first walk; a commit takes the
  // lane expecting its hash (or a new one), then bequeaths the lane to its first parent.
  function assignLanes(commits) {
    var lanes = [] // lane index -> next expected hash (or null when free)
    commits.forEach(function (c) {
      var lane = lanes.indexOf(c.hash)
      if (lane < 0) {
        lane = lanes.indexOf(null)
        if (lane < 0) {
          lane = lanes.length
          lanes.push(null)
        }
      }
      c._lane = lane
      var parents = c.parents || []
      lanes[lane] = parents.length ? parents[0] : null
      for (var i = 1; i < parents.length; i++) {
        if (lanes.indexOf(parents[i]) < 0) {
          var free = lanes.indexOf(null)
          if (free < 0) lanes.push(parents[i])
          else lanes[free] = parents[i]
        }
      }
      c._lanesActive = lanes.filter(function (h) {
        return h !== null
      }).length
      c._laneCount = lanes.length
    })
    return commits
  }
  var LANE_COLORS = ['#5b9cff', '#3fb950', '#f0883e', '#db61a2', '#a371f7', '#39c5cf', '#e3b341']

  function renderCommitList(list) {
    clear(list)
    var log = repo.log
    if (!log || isErr(log)) return
    var commits = assignLanes((log.commits || []).slice())
    var q = repo.historySearch.trim().toLowerCase()
    var shown = 0
    commits.forEach(function (c) {
      if (q) {
        var hay = (c.subject + ' ' + c.author + ' ' + c.short + ' ' + c.hash).toLowerCase()
        if (hay.indexOf(q) < 0) return
      }
      shown++
      list.appendChild(commitRow(c, !q))
    })
    if (!shown) list.appendChild(paneEmpty(q ? 'No commits match.' : 'No commits.'))
  }

  function commitRow(c, withGraph) {
    var inSession = c.date && Date.parse(c.date) >= sessionStart
    var row = el('div', 'commit-row' + (inSession ? ' session' : ''))
    if (withGraph) {
      var gutterWidth = Math.min(c._laneCount || 1, 6) * 8 + 4
      var g = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      g.setAttribute('class', 'lane-svg')
      g.setAttribute('width', gutterWidth)
      g.setAttribute('height', 30)
      for (var li = 0; li < Math.min(c._laneCount || 1, 6); li++) {
        var xPos = 5 + li * 8
        var line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        line.setAttribute('x1', xPos)
        line.setAttribute('x2', xPos)
        line.setAttribute('y1', 0)
        line.setAttribute('y2', 30)
        line.setAttribute('stroke', LANE_COLORS[li % LANE_COLORS.length])
        line.setAttribute('stroke-opacity', '0.35')
        g.appendChild(line)
      }
      var laneShown = Math.min(c._lane, 5)
      var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      dot.setAttribute('cx', 5 + laneShown * 8)
      dot.setAttribute('cy', 15)
      dot.setAttribute('r', (c.parents || []).length > 1 ? 2.4 : 3.2)
      dot.setAttribute('fill', LANE_COLORS[laneShown % LANE_COLORS.length])
      g.appendChild(dot)
      row.appendChild(g)
    }
    var main = el('div', 'commit-main')
    var subj = el('div', 'commit-subj')
    ;(c.refs || []).forEach(function (ref) {
      var chip = el(
        'span',
        'ref-chip' + (/^tag:/.test(ref) ? ' tag' : /HEAD/.test(ref) ? ' head' : ''),
        ref.replace(/^tag:\s*/, '')
      )
      subj.appendChild(chip)
    })
    subj.appendChild(document.createTextNode(c.subject))
    if (inSession) subj.appendChild(el('span', 'session-badge', 'this session'))
    main.appendChild(subj)
    var meta = el('div', 'commit-meta')
    meta.appendChild(el('span', 'hash', c.short))
    meta.appendChild(el('span', 'author', c.author))
    meta.appendChild(el('span', 'date', relTime(c.date)))
    main.appendChild(meta)
    row.appendChild(main)
    row.addEventListener('click', function () {
      Array.prototype.forEach.call(navEl.querySelectorAll('.commit-row'), function (x) {
        x.classList.toggle('selected', x === row)
      })
      showCommit(c)
    })
    return row
  }

  function showCommit(c) {
    rdTitle.textContent = short(c.subject, 70)
    rdMeta.textContent = c.short
    clear(rdBody)
    var head = el('div', 'commit-detail-head')
    var subj = el('div', 'commit-subj big', c.subject)
    head.appendChild(subj)
    var hm = el('div', 'commit-meta')
    hm.appendChild(el('span', 'hash', c.hash))
    hm.appendChild(el('span', 'author', c.author + ' <' + c.email + '>'))
    hm.appendChild(el('span', 'date', c.date))
    head.appendChild(hm)
    if ((c.refs || []).length) {
      var refs = el('div', 'commit-refs')
      c.refs.forEach(function (ref) {
        refs.appendChild(el('span', 'ref-chip' + (/^tag:/.test(ref) ? ' tag' : ''), ref))
      })
      head.appendChild(refs)
    }
    rdBody.appendChild(head)

    // Full message body + file list arrive via the commit op; diffs via commitDiff.
    rpc('commit', { hash: c.hash }).then(function (info) {
      if (isErr(info)) return
      if (info.commit && info.commit.body) {
        rdBody.insertBefore(el('pre', 'commit-body', info.commit.body), head.nextSibling)
      }
      var files = el('div', 'commit-files')
      ;(info.files || []).forEach(function (f) {
        var row = el('div', 'file-row static')
        row.appendChild(
          el('span', 'st ' + (f.status || '?').toUpperCase(), (f.status || '?').toUpperCase())
        )
        row.appendChild(el('span', 'fp', f.orig ? f.orig + ' → ' + f.path : f.path))
        files.appendChild(row)
      })
      rdBody.appendChild(files)
      var diffBox = el('div', 'diff')
      diffBox.appendChild(el('div', 'pane-empty', 'Loading diff…'))
      rdBody.appendChild(diffBox)
      rpc('commitDiff', { hash: c.hash }).then(function (d) {
        clear(diffBox)
        renderMultiDiffInto(diffBox, d)
      })
    })
  }

  /* Branches & worktrees */
  function buildBranchesSection() {
    var r = repo.branches
    var x = section(
      'branches',
      'Branches & worktrees',
      r && !isErr(r) ? (r.branches || []).length : null
    )
    if (!r) x.body.appendChild(paneEmpty('Loading…'))
    else if (isErr(r)) x.body.appendChild(paneEmpty(r.error))
    else {
      ;(r.branches || []).forEach(function (b) {
        var row = el('div', 'br-row' + (b.current ? ' current' : ''))
        row.appendChild(el('span', 'br-name', (b.current ? '● ' : '') + b.name))
        if (b.ahead || b.behind) {
          var ab = el('span', 'br-ab')
          if (b.ahead) ab.appendChild(el('span', 'ahead', '↑' + b.ahead))
          if (b.behind) ab.appendChild(el('span', 'behind', ' ↓' + b.behind))
          row.appendChild(ab)
        }
        row.appendChild(el('span', 'br-subj', b.subject || ''))
        row.title = b.upstream ? 'tracks ' + b.upstream : 'no upstream'
        x.body.appendChild(row)
      })
      if ((r.worktrees || []).length) {
        x.body.appendChild(el('div', 'group-label', 'Worktrees (' + r.worktrees.length + ')'))
        r.worktrees.forEach(function (w, wi) {
          var row = el('div', 'wt-row')
          row.appendChild(
            el('span', 'br-name', w.branch || (w.detached ? '(detached)' : w.bare ? '(bare)' : '?'))
          )
          var note = worktreeNote(w, wi)
          if (note) row.appendChild(el('span', 'wt-agent ' + note.cls, note.text))
          row.appendChild(el('span', 'br-subj', w.path))
          if (w.locked) row.appendChild(el('span', 'br-track', 'locked'))
          x.body.appendChild(row)
        })
      }
    }
    return x.sec
  }

  // Which agent/session is on a worktree — best-effort from this repo's conventions
  // (docs/MULTI_AGENT.md: one worktree + one feat/<topic> branch per parallel session).
  function worktreeNote(w, index) {
    if (cwd && normPath(w.path) === normPath(cwd)) {
      return { cls: 'me', text: 'this conversation' }
    }
    if (index === 0) return { cls: '', text: 'primary checkout' }
    if (w.branch && /^(feat|fix|wt)\//.test(w.branch)) {
      return { cls: 'other', text: 'agent session · ' + w.branch.replace(/^[^/]+\//, '') }
    }
    return { cls: 'other', text: 'other session' }
  }

  /* Stashes (hidden when none) */
  function buildStashSection() {
    var r = repo.stashes
    var list = r && !isErr(r) ? r.stashes || [] : []
    if (r && !isErr(r) && !list.length) return null
    var x = section('stashes', 'Stashes', list.length)
    if (!r) x.body.appendChild(paneEmpty('Loading…'))
    else if (isErr(r)) x.body.appendChild(paneEmpty(r.error))
    else
      list.forEach(function (st) {
        var row = el('div', 'stash-row')
        row.appendChild(el('span', 'hash', st.ref))
        row.appendChild(el('span', 'br-subj', st.subject))
        row.appendChild(el('span', 'date', relTime(st.date)))
        row.addEventListener('click', function () {
          rdTitle.textContent = st.ref
          rdMeta.textContent = st.subject
          clear(rdBody)
          rdBody.appendChild(el('div', 'pane-empty', 'Loading stash diff…'))
          rpc('stashDiff', { ref: st.ref }).then(function (d) {
            clear(rdBody)
            renderMultiDiffInto(rdBody, d)
          })
        })
        x.body.appendChild(row)
      })
    return x.sec
  }

  /* Submodules (hidden when none) */
  function buildSubmoduleSection() {
    var r = repo.submodules
    var list = r && !isErr(r) ? r.submodules || [] : []
    if (!list.length) return null
    var x = section('submodules', 'Submodules', list.length)
    list.forEach(function (sm) {
      var row = el('div', 'stash-row')
      row.appendChild(el('span', 'sm-flag ' + sm.flag, sm.flag))
      row.appendChild(el('span', 'br-name', sm.path))
      row.appendChild(el('span', 'hash', sm.sha.slice(0, 7)))
      if (sm.describe) row.appendChild(el('span', 'br-subj', sm.describe))
      x.body.appendChild(row)
    })
    return x.sec
  }

  /* CI */
  function buildCiSection() {
    var r = repo.ci
    var x = section('ci', 'CI (GitHub)', r && !isErr(r) ? (r.runs || []).length : null)
    if (!r) x.body.appendChild(paneEmpty('Loading…'))
    else if (isErr(r)) {
      var msg =
        r.error === 'gh not found'
          ? 'GitHub CLI (gh) not installed — CI status unavailable.'
          : r.error === 'not a git repository'
            ? 'This folder is not a git repository.'
            : 'gh: ' + r.error
      x.body.appendChild(paneEmpty(msg))
    } else if (!(r.runs || []).length) {
      x.body.appendChild(paneEmpty('No workflow runs for this branch.'))
    } else {
      r.runs.forEach(function (run) {
        var glyph = run.status === 'completed' ? (run.conclusion === 'success' ? '✓' : '✗') : '●'
        var cls =
          run.status !== 'completed'
            ? 'run-live'
            : run.conclusion === 'success'
              ? 'run-ok'
              : 'run-bad'
        var row = el('div', 'ci-row')
        row.appendChild(el('span', 'ci-glyph ' + cls, glyph))
        var main = el('div', 'commit-main')
        main.appendChild(
          el('div', 'commit-subj', run.name + ' — ' + short(run.displayTitle || '', 60))
        )
        var meta = el('div', 'commit-meta')
        meta.appendChild(el('span', 'author', run.headBranch || ''))
        meta.appendChild(
          el('span', 'date', (run.event || '') + ' · ' + relTime(run.updatedAt || run.createdAt))
        )
        meta.appendChild(el('span', 'hash', run.conclusion || run.status))
        main.appendChild(meta)
        row.appendChild(main)
        if (run.url) {
          var cp = el('span', 'turns-chip', 'copy url')
          cp.title = run.url
          cp.addEventListener('click', function (e) {
            e.stopPropagation()
            try {
              navigator.clipboard.writeText(run.url)
              cp.textContent = 'copied ✓'
              setTimeout(function () {
                cp.textContent = 'copy url'
              }, 1500)
            } catch (err) {
              /* clipboard unavailable */
            }
          })
          row.appendChild(cp)
        }
        x.body.appendChild(row)
      })
    }
    return x.sec
  }

  /* ── diff rendering (shared) ───────────────────────────────────────────── */
  function renderDiffInto(target, r) {
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
    appendHunks(target, r)
    if (r.truncated) target.appendChild(el('div', 'pane-empty', '… diff truncated at 500KB …'))
  }
  function renderMultiDiffInto(target, d) {
    if (isErr(d)) {
      target.appendChild(paneEmpty(d.error))
      return
    }
    var files = (d && d.files) || []
    if (!files.length) {
      target.appendChild(paneEmpty('No changes to show.'))
      return
    }
    files.forEach(function (f) {
      var head = el('div', 'diff-file-head')
      head.appendChild(
        el(
          'span',
          'fp',
          f.oldPath && f.oldPath !== f.file ? f.oldPath + ' → ' + f.file : f.file || ''
        )
      )
      head.appendChild(el('span', 'diff-counts', '+' + f.additions + ' −' + f.deletions))
      target.appendChild(head)
      if (f.binary) target.appendChild(paneEmpty('Binary file.'))
      else appendHunks(target, f)
    })
    if (d.truncated) target.appendChild(el('div', 'pane-empty', '… diff truncated at 500KB …'))
  }
  function appendHunks(target, r) {
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
  }

  /* ═══════════════════════ AGENT LOG ══════════════════════════════════════ */
  var LEVEL_NAMES = { 1: 'turns', 2: 'tools', 3: 'all', 4: 'raw' }
  function tierOf(kind) {
    if (kind === 'result' || kind === 'error') return 1
    if (kind === 'tool_use' || kind === 'tool_result' || kind === 'tokens') return 2
    return 3
  }

  function ingest(ev, live) {
    if (!ev || typeof ev !== 'object') return null
    var k = ev.kind
    // Coalesce consecutive text/thinking deltas of the same message into one row
    // (keeps the row at its first-delta position — order stays exact).
    if ((k === 'text' || k === 'thinking') && events.length) {
      var last = events[events.length - 1]
      if (last.ev.kind === k && last.ev.messageId === ev.messageId) {
        last.text = (last.text || '') + (ev.delta || '')
        return last
      }
    }
    var entry = {
      seq: ++seqNo,
      ts: typeof ev.ts === 'number' ? ev.ts : live ? Date.now() : null,
      ev: ev,
      text: k === 'text' || k === 'thinking' ? ev.delta || '' : null
    }
    events.push(entry)
    if (k === 'tool_use') {
      toolStarts[ev.toolUseId] = { entry: entry, at: Date.now() }
      var fp = toolFile(ev.name, ev.input)
      if (fp) {
        var p = normPath(fp)
        entry.file = fp
        fileIndex[p] = (fileIndex[p] || 0) + 1
      }
    } else if (k === 'tool_result') {
      var t = toolStarts[ev.toolUseId]
      if (t) {
        entry.forTool = t.entry
        if (live) entry.durationMs = Date.now() - t.at
      }
    }
    return entry
  }

  function toolFile(name, input) {
    if (!input || typeof input !== 'object') return null
    var fileTools = { Write: 1, Edit: 1, MultiEdit: 1, NotebookEdit: 1, Read: 1 }
    if (fileTools[name]) return input.file_path || input.path || input.filePath || null
    return null
  }

  function passes(entry) {
    var ev = entry.ev
    if (tierOf(ev.kind) > state.level && state.level < 3) return false
    if (state.level >= 3) {
      /* L3/L4 show everything */
    }
    var f = state.filter
    if (f === 'tools' && !(ev.kind === 'tool_use' || ev.kind === 'tool_result')) return false
    if (f === 'files' && !entry.file && !(entry.forTool && entry.forTool.file)) return false
    if (f === 'errors') {
      var isError =
        ev.kind === 'error' ||
        (ev.kind === 'tool_result' && ev.ok === false) ||
        (ev.kind === 'result' && ev.isError)
      if (!isError) return false
    }
    if (f === 'atelier') {
      var atelierKinds = {
        permission_request: 1,
        permission_resolved: 1,
        question_request: 1,
        question_resolved: 1,
        permission_mode: 1,
        status: 1,
        auto_resume: 1,
        background: 1,
        system_init: 1,
        task_activity: 1
      }
      if (!atelierKinds[ev.kind]) return false
    }
    if (state.search) {
      var hay = (summaryFor(entry) + ' ' + ev.kind + ' ' + (entry.file || '')).toLowerCase()
      if (hay.indexOf(state.search.toLowerCase()) < 0) return false
    }
    return true
  }

  function summaryFor(entry) {
    var ev = entry.ev
    var k = ev.kind
    if (k === 'tool_use') {
      var input = ev.input
      var hint = ''
      if (entry.file) hint = String(entry.file)
      else if (input && typeof input === 'object') {
        if (ev.name === 'Bash') hint = input.command || ''
        else if (input.pattern || input.query) hint = input.pattern || input.query
        else if (input.description) hint = input.description
        else {
          try {
            hint = JSON.stringify(input)
          } catch (e) {
            hint = ''
          }
        }
      }
      return ev.name + '  ' + short(hint, 100)
    }
    if (k === 'tool_result') {
      var base =
        (ev.ok === false ? 'failed' : 'ok') +
        (entry.durationMs != null ? ' · ' + fmtDur(entry.durationMs) : '')
      var out = ev.output != null ? short(String(ev.output).trim(), 80) : ''
      return base + (out ? ' · ' + out : '')
    }
    if (k === 'text' || k === 'thinking') return short((entry.text || '').trim(), 140)
    if (k === 'result') {
      var bits = []
      if (ev.durationMs != null) bits.push(fmtDur(ev.durationMs))
      if (ev.costUsd != null) bits.push('$' + Number(ev.costUsd).toFixed(4))
      if (ev.isError) bits.push('ERROR')
      return 'turn finished' + (bits.length ? ' · ' + bits.join(' · ') : '')
    }
    if (k === 'tokens')
      return (
        (ev.output != null ? ev.output + ' out' : '') +
        (ev.input != null ? ' / ' + ev.input + ' in' : '')
      )
    if (k === 'error') return short(ev.message || 'error', 160)
    if (k === 'permission_request')
      return short(ev.title || ev.toolName || 'permission needed', 100)
    if (k === 'question_request') return 'question for you'
    if (k === 'permission_resolved' || k === 'question_resolved') return 'resolved'
    if (k === 'status') return short(ev.text || ev.status || '', 80)
    if (k === 'system_init') return 'session initialized'
    try {
      return short(JSON.stringify(ev), 100)
    } catch (e) {
      return ''
    }
  }

  function badgeClass(kind) {
    if (kind === 'tool_use') return 'b-tool'
    if (kind === 'tool_result') return 'b-toolr'
    if (kind === 'result') return 'b-result'
    if (kind === 'error') return 'b-err'
    if (kind === 'text') return 'b-text'
    if (kind === 'thinking') return 'b-think'
    if (/^permission|^question/.test(kind)) return 'b-perm'
    return 'b-sys'
  }

  function agentRow(entry) {
    var ev = entry.ev
    var row = el('div', 'ag-row')
    if (ev.kind === 'error' || (ev.kind === 'tool_result' && ev.ok === false))
      row.classList.add('err')
    row.appendChild(el('span', 'ag-seq', '#' + entry.seq))
    row.appendChild(el('span', 'ag-time', entry.ts ? clock(entry.ts) : '·'))
    row.appendChild(el('span', 'ag-kind ' + badgeClass(ev.kind), ev.kind))
    row.appendChild(el('span', 'ag-sum', summaryFor(entry)))
    if (entry.file) {
      var vd = el('span', 'viewdiff', 'view diff')
      vd.addEventListener('click', function (e) {
        e.stopPropagation()
        openFileInRepo(entry.file)
      })
      row.appendChild(vd)
    }
    if (state.level === 4) {
      row.classList.add('expandable')
      row.addEventListener('click', function () {
        var next = row.nextSibling
        if (next && next.classList && next.classList.contains('ag-raw')) {
          next.remove()
          return
        }
        var pre = el('pre', 'ag-raw')
        try {
          pre.textContent = JSON.stringify(ev, null, 2)
        } catch (e) {
          pre.textContent = String(ev)
        }
        row.after(pre)
      })
    }
    return row
  }

  function renderAgent() {
    clear(agList)
    if (!events.length) {
      agList.appendChild(el('div', 'pane-empty', 'No agent activity yet in this conversation.'))
      return
    }
    var frag = document.createDocumentFragment()
    var shown = 0
    events.forEach(function (entry) {
      if (!passes(entry)) return
      shown++
      frag.appendChild(agentRow(entry))
    })
    if (!shown) agList.appendChild(el('div', 'pane-empty', 'Nothing at this verbosity/filter.'))
    else agList.appendChild(frag)
    if (state.follow) agList.scrollTop = agList.scrollHeight
  }

  function appendLive(entry) {
    if (state.tab !== 'agent' || !entry) return
    if (!passes(entry)) return
    var empty = agList.querySelector('.pane-empty')
    if (empty) empty.remove()
    agList.appendChild(agentRow(entry))
    if (state.follow) agList.scrollTop = agList.scrollHeight
  }

  /* Cross-links */
  function openFileInRepo(file) {
    setTab('repo')
    state.sections.worktree = false
    persist()
    // After the status refresh renders, click the matching row (suffix match — agent
    // paths are absolute, git paths repo-relative).
    setTimeout(function () {
      var rows = navEl.querySelectorAll('.file-row')
      var want = normPath(file)
      for (var i = 0; i < rows.length; i++) {
        var fp = rows[i].querySelector('.fp')
        var p = normPath(fp ? fp.title || fp.textContent : '')
        if (p && (want.slice(-p.length) === p || p.slice(-want.length) === want)) {
          rows[i].click()
          return
        }
      }
    }, 350)
  }
  function showFileInAgent(path) {
    setTab('agent')
    if (state.level < 2) setLevel(2)
    agSearch.value = path.split('/').pop()
    state.search = agSearch.value
    renderAgent()
  }

  /* Agent bar wiring */
  function setLevel(lv) {
    state.level = lv
    agLevel.value = String(lv)
    agLevelName.textContent = LEVEL_NAMES[lv]
    persist()
    renderAgent()
  }
  agLevel.addEventListener('input', function () {
    setLevel(parseInt(agLevel.value, 10) || 2)
  })
  $('#ag-filters').addEventListener('click', function (e) {
    var c = e.target.closest('.chip')
    if (!c) return
    state.filter = c.getAttribute('data-filter')
    Array.prototype.forEach.call(this.children, function (b) {
      b.classList.toggle('active', b === c)
    })
    persist()
    renderAgent()
  })
  var searchDeb = null
  agSearch.addEventListener('input', function () {
    clearTimeout(searchDeb)
    searchDeb = setTimeout(function () {
      state.search = agSearch.value
      renderAgent()
    }, 150)
  })
  agPin.addEventListener('click', function () {
    state.follow = !state.follow
    agPin.classList.toggle('active', state.follow)
    if (state.follow) agList.scrollTop = agList.scrollHeight
  })
  agList.addEventListener('scroll', function () {
    // Scrolling up unpins; returning to the bottom re-pins.
    var atBottom = agList.scrollTop + agList.clientHeight >= agList.scrollHeight - 8
    if (!atBottom && state.follow) {
      state.follow = false
      agPin.classList.remove('active')
    } else if (atBottom && !state.follow) {
      state.follow = true
      agPin.classList.add('active')
    }
  })

  /* ═══════════════════════ WIRING ═════════════════════════════════════════ */
  // Guarded: a missing capability must degrade that feed, not kill the whole script
  // (a top-level throw here would leave a completely dead pane).
  try {
    atelier.agent.onEvent(function (ev) {
      var entry = ingest(ev, true)
      appendLive(entry)
      // A completed file-writing tool refreshes the working tree when Repo is visible.
      if (ev && ev.kind === 'tool_result' && state.tab === 'repo') {
        var t = toolStarts[ev.toolUseId]
        if (t && t.entry.file) {
          rpc('status').then(function (r) {
            repo.status = r
            renderHealth()
            renderNav()
          })
        }
      }
    })
  } catch (e) {
    /* agent:read unavailable — the log stays on backfill only */
  }

  // Pushed refresh from the backend's debounced flow:status timer.
  try {
    atelier.data.subscribe('flow:status', function (status) {
      repo.status = status
      if (state.tab === 'repo') {
        renderHealth()
        renderNav()
      }
    })
  } catch (e) {
    /* data:subscribe unavailable — manual/RPC refreshes still work */
  }

  // Fail-visible guard: an uncaught error must render INTO the pane, never leave a
  // silent blank (which is indistinguishable from "the plugin does nothing").
  function showFatal(msg) {
    var bar = document.createElement('div')
    bar.className = 'pane-empty'
    bar.style.color = 'var(--err, #e06c75)'
    bar.textContent = 'agent-flow error: ' + msg + ' — try reloading the plugin.'
    document.body.insertBefore(bar, document.body.firstChild)
  }
  window.addEventListener('error', function (e) {
    showFatal((e && e.message) || 'uncaught error')
  })
  window.addEventListener('unhandledrejection', function (e) {
    showFatal((e && e.reason && e.reason.message) || 'unhandled rejection')
  })

  var mounted = false
  function mount() {
    if (mounted) return
    mounted = true
    // Show the default tab IMMEDIATELY — restores/backfill only refine it. The previous
    // version activated a tab only at the end of the storage→history promise chain, so
    // any rejection left BOTH panels display:none (a blank pane with two dead-looking
    // tabs). Never gate first paint on async work.
    setTab(state.tab)
    atelier.agent
      .info()
      .then(function (info) {
        if (info && info.cwd) cwd = info.cwd
      })
      .catch(function () {})
    atelier.storage
      .get('ui')
      .catch(function () {
        return null
      })
      .then(function (saved) {
        if (saved && typeof saved === 'object') {
          if (saved.tab === 'repo' || saved.tab === 'agent') state.tab = saved.tab
          if (saved.level >= 1 && saved.level <= 4) state.level = saved.level
          if (saved.filter) state.filter = saved.filter
          if (saved.sections && typeof saved.sections === 'object') state.sections = saved.sections
          if (saved.selectedFile) state.selectedFile = saved.selectedFile
          state.selectedStaged = !!saved.selectedStaged
        }
        agLevel.value = String(state.level)
        agLevelName.textContent = LEVEL_NAMES[state.level]
        agPin.classList.toggle('active', state.follow)
        Array.prototype.forEach.call($('#ag-filters').children, function (b) {
          b.classList.toggle('active', b.getAttribute('data-filter') === state.filter)
        })
        return atelier.agent.history(1000).catch(function () {
          return null
        })
      })
      .then(function (hist) {
        if (Array.isArray(hist))
          hist.forEach(function (ev) {
            ingest(ev, false)
          })
        setTab(state.tab)
      })
      .catch(function (err) {
        // Belt and braces — the pane still shows the default tab from the sync setTab.
        showFatal((err && err.message) || 'mount failed')
      })
  }

  atelier.on('load', mount)
  // If 'load' already fired before this script ran (fresh mount), run immediately.
  mount()
})()
