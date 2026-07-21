/* ───────────────────────────────────────────────────────────────────────────
   Whiteboard — orchestration.
   Owns the in-memory doc, the tab strip, board rendering delegation, the comment
   thread, and the bidirectional sync loop against context key "boards".

   Sync discipline (spec §5):
     - load: read context.get('boards'), render; restore active tab from storage.
     - context event: re-read; if parse fails → non-destructive banner (never
       overwrite). If ok → replace local model, preserving the active tab unless the
       agent steered `active` (and the user hasn't clicked a tab in the last 30s).
     - user edit: mutate local doc synchronously, re-render, debounce context.set(400ms).
       A pane's own context.set does NOT echo a context event (guarded by lastPushed).
   ─────────────────────────────────────────────────────────────────────────── */
;(function (root) {
  'use strict'
  var WB = root.WB
  var A = root.atelier
  var MAX_TOKENS = 4000
  var USER_TAB_GUARD_MS = 30000

  // ── DOM refs ──
  var tabStrip, addMenuBtn, addMenu, boardArea, banner, statusEl, sizeWarn, commentsEl

  // ── State ──
  var doc = { boards: [] } // current valid model
  var malformed = null // { raw, error } when the export can't parse
  var activeId = null // currently-focused board id (pane-local)
  var lastUserTabClick = 0 // ts of last manual tab selection
  var lastPushedValue = null // last serialized value WE wrote (suppress echo)
  var saveTimer = null
  var confirmDeleteId = null // tab showing the inline delete confirm (sandbox has no confirm())
  var renamingId = null // tab showing the inline rename input
  var noteModes = {} // board id -> 'preview' | 'edit' | 'split' (in-memory)
  var chartEditorOpen = {} // board id -> bool (in-memory)

  function init() {
    tabStrip = document.getElementById('tab-strip')
    addMenuBtn = document.getElementById('add-menu-btn')
    addMenu = document.getElementById('add-menu')
    boardArea = document.getElementById('board-area')
    banner = document.getElementById('banner')
    statusEl = document.getElementById('status')
    sizeWarn = document.getElementById('size-warn')
    commentsEl = document.getElementById('comments')

    wireAddMenu()

    A.on('load', onLoad)
    A.on('context', onContextEvent)

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () {
        // Re-render active board on resize (charts/mermaid depend on size).
        if (activeId) renderActiveBoard()
      }).observe(boardArea)
    }
  }

  /* ── Load ─────────────────────────────────────────────────────────── */
  function onLoad() {
    status('loading…')
    A.context
      .get('boards')
      .then(function (val) {
        applyIncoming(val, /*fromLoad*/ true)
        // restore last active tab from storage (only if still present)
        return A.storage.get('activeTab')
      })
      .then(function (savedTab) {
        if (!malformed && savedTab && WB.findBoard(doc, savedTab)) {
          activeId = savedTab
        }
        renderAll()
        status(doc.boards.length ? 'ready' : 'ready — no boards yet')
      })
      .catch(function (e) {
        status('load error: ' + (e && e.message))
        // Still render — the onboarding/empty state must appear even when the initial
        // context read fails; a status-line-only error reads as a blank, broken pane.
        renderAll()
      })
  }

  /* ── External context event (agent edit) ─────────────────────────── */
  function onContextEvent(p) {
    if (!p || p.key !== 'boards') return
    A.context
      .get('boards')
      .then(function (val) {
        // Suppress our own echo (host shouldn't echo, but be defensive).
        if (typeof val === 'string' && val === lastPushedValue) return
        var openEditor = boardArea.querySelector('input, textarea')
        var prevActive = activeId
        var prevDoc = doc
        applyIncoming(val, false)
        if (!malformed) {
          // Agent may steer active — honor it unless the user clicked recently.
          var wantActive = doc.active
          var recentUser = Date.now() - lastUserTabClick < USER_TAB_GUARD_MS
          if (wantActive && WB.findBoard(doc, wantActive) && !recentUser) {
            activeId = wantActive
          } else if (!WB.findBoard(doc, prevActive)) {
            activeId = doc.boards.length ? doc.boards[0].id : null
          } else {
            activeId = prevActive
          }
          // If a cell the user is editing changed remotely, flash it.
          if (openEditor && activeId && WB.boardFieldChanged(prevDoc, doc, activeId, 'rows')) {
            flashBoardArea()
          }
          renderAll()
          status('updated by agent')
          setTimeout(function () {
            if (statusEl.textContent === 'updated by agent') status('ready')
          }, 2500)
        } else {
          renderAll()
        }
      })
      .catch(function () {})
  }

  /* Parse an incoming value into the model or the malformed banner. */
  function applyIncoming(val, fromLoad) {
    var res = WB.parse(val)
    if (!res.ok) {
      malformed = { raw: res.raw, error: res.error }
      return
    }
    malformed = null
    doc = res.doc
    if (!activeId || !WB.findBoard(doc, activeId)) {
      activeId = doc.boards.length ? doc.boards[0].id : null
    }
    void fromLoad
  }

  /* ── Persist (debounced) ──────────────────────────────────────────── */
  function scheduleSave(reason) {
    clearTimeout(saveTimer)
    status('…' + (reason || 'edited'))
    saveTimer = setTimeout(function () {
      var val = WB.serialize(doc)
      lastPushedValue = val
      A.context
        .set('boards', val)
        .then(function () {
          status('saved ✓')
          updateSizeWarn()
        })
        .catch(function (e) {
          status('save error: ' + (e && e.message))
        })
    }, 400)
  }

  // Apply a mutation to the whole doc (fn receives the doc, returns new doc), persist.
  function mutateDoc(fn, reason) {
    doc = fn(doc)
    renderAll()
    scheduleSave(reason)
  }

  // Same, but WITHOUT re-rendering — for live-typing editors (note markdown, mermaid
  // source) that already reflect the change. Re-rendering mid-typing rebuilds the
  // textarea and dumps focus the moment the debounce fires; this was the "can't write
  // in the note board" bug.
  function mutateDocSilent(fn, reason) {
    doc = fn(doc)
    scheduleSave(reason)
  }

  /* ── Render everything ────────────────────────────────────────────── */
  function renderAll() {
    renderBanner()
    renderTabs()
    renderActiveBoard()
    renderComments()
    updateSizeWarn()
  }

  function renderBanner() {
    if (!malformed) {
      banner.style.display = 'none'
      banner.innerHTML = ''
      return
    }
    banner.style.display = 'block'
    banner.innerHTML = ''
    var head = document.createElement('div')
    head.className = 'banner-head'
    head.textContent =
      '⚠ The boards export is not valid JSON — showing raw text below. Your data is NOT overwritten; fix it here or ask the agent to correct it.'
    var errEl = document.createElement('div')
    errEl.className = 'banner-err'
    errEl.textContent = malformed.error
    var ta = document.createElement('textarea')
    ta.className = 'banner-ta'
    ta.value = malformed.raw
    ta.spellcheck = false
    var btn = document.createElement('button')
    btn.className = 'wb-mini-btn'
    btn.textContent = 'fix in place → save'
    btn.addEventListener('click', function () {
      var res = WB.parse(ta.value)
      if (!res.ok) {
        errEl.textContent = 'still invalid: ' + res.error
        return
      }
      // Valid now — adopt it and persist.
      doc = res.doc
      malformed = null
      activeId = doc.boards.length ? doc.boards[0].id : null
      renderAll()
      scheduleSave('fixed')
    })
    banner.appendChild(head)
    banner.appendChild(errEl)
    banner.appendChild(ta)
    banner.appendChild(btn)
    // Hide the tab/board UI while malformed to avoid implying data loss.
    tabStrip.parentElement.style.display = 'none'
  }

  function renderTabs() {
    if (malformed) return
    tabStrip.parentElement.style.display = ''
    tabStrip.innerHTML = ''
    doc.boards.forEach(function (b) {
      var tab = document.createElement('div')
      tab.className = 'tab' + (b.id === activeId ? ' active' : '')

      // Inline delete confirm — the sandbox has no confirm()/prompt(), so native
      // dialogs silently no-op. The × swaps the tab into a "delete?" state instead.
      if (confirmDeleteId === b.id) {
        tab.classList.add('confirming')
        var q = document.createElement('span')
        q.className = 'tab-label'
        q.textContent = 'delete “' + (b.title || b.id) + '”?'
        var yes = document.createElement('span')
        yes.className = 'tab-confirm yes'
        yes.textContent = '✓'
        yes.title = 'Delete this board'
        yes.addEventListener('click', function (e) {
          e.stopPropagation()
          confirmDeleteId = null
          deleteBoard(b.id)
        })
        var no = document.createElement('span')
        no.className = 'tab-confirm no'
        no.textContent = '✗'
        no.title = 'Keep it'
        no.addEventListener('click', function (e) {
          e.stopPropagation()
          confirmDeleteId = null
          renderTabs()
        })
        tab.appendChild(q)
        tab.appendChild(yes)
        tab.appendChild(no)
        tabStrip.appendChild(tab)
        return
      }

      var glyph = document.createElement('span')
      glyph.className = 'tab-glyph'
      glyph.textContent = typeGlyph(b.type)
      glyph.title = b.type
      tab.appendChild(glyph)

      // Inline rename (dblclick) — again, no prompt() in the sandbox.
      if (renamingId === b.id) {
        var input = document.createElement('input')
        input.className = 'tab-rename'
        input.value = b.title || b.id
        var commit = function (save) {
          renamingId = null
          var name = input.value.trim()
          if (save && name && name !== (b.title || b.id)) {
            mutateDoc(function (d) {
              return WB.updateBoard(d, b.id, function (bb) {
                bb.title = name
              })
            }, 'rename')
          } else {
            renderTabs()
          }
        }
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') commit(true)
          else if (e.key === 'Escape') commit(false)
          e.stopPropagation()
        })
        input.addEventListener('blur', function () {
          commit(true)
        })
        input.addEventListener('click', function (e) {
          e.stopPropagation()
        })
        tab.appendChild(input)
        tabStrip.appendChild(tab)
        requestAnimationFrame(function () {
          input.focus()
          input.select()
        })
        return
      }

      var label = document.createElement('span')
      label.className = 'tab-label'
      label.textContent = b.title || b.id
      tab.appendChild(label)
      tab.addEventListener('click', function () {
        lastUserTabClick = Date.now()
        activeId = b.id
        A.storage.set('activeTab', activeId).catch(function () {})
        renderAll()
      })
      tab.addEventListener('dblclick', function () {
        renamingId = b.id
        confirmDeleteId = null
        renderTabs()
      })
      // delete button → inline confirm state
      var del = document.createElement('span')
      del.className = 'tab-del'
      del.textContent = '×'
      del.title = 'Delete board'
      del.addEventListener('click', function (e) {
        e.stopPropagation()
        confirmDeleteId = b.id
        renamingId = null
        renderTabs()
      })
      tab.appendChild(del)
      tabStrip.appendChild(tab)
    })
  }

  function typeGlyph(t) {
    return t === 'mermaid' ? '❖' : t === 'table' ? '▦' : t === 'chart' ? '▮' : '¶'
  }

  function renderActiveBoard() {
    if (malformed) return
    boardArea.innerHTML = ''
    var b = WB.findBoard(doc, activeId)
    if (!b) {
      boardArea.appendChild(buildEmptyState(doc.boards.length === 0))
      return
    }
    var view = document.createElement('div')
    view.className = 'board-view'
    boardArea.appendChild(view)

    if (b.type === 'mermaid') {
      var mmHost = document.createElement('div')
      mmHost.className = 'wb-mermaid-host'
      view.appendChild(mmHost)
      root.WBMermaid.renderMermaid(mmHost, b)
      appendSourceEditor(view, b, 'source', 'mermaid source')
    } else if (b.type === 'table') {
      var tHost = document.createElement('div')
      tHost.className = 'wb-table-host'
      view.appendChild(tHost)
      root.WBTable.render(tHost, b, function (mutator) {
        mutateDoc(function (d) {
          return WB.updateBoard(d, b.id, mutator)
        }, 'table')
      })
    } else if (b.type === 'chart') {
      renderChartBoard(view, b)
    } else if (b.type === 'note') {
      renderNoteBoard(view, b)
    } else {
      var un = document.createElement('div')
      un.className = 'wb-empty'
      un.textContent = 'Unknown board type "' + b.type + '" — preserved but not rendered.'
      view.appendChild(un)
    }
  }

  // Teaching empty state — a fresh pane must explain itself, not show a blank page.
  function buildEmptyState(noBoardsAtAll) {
    var box = document.createElement('div')
    box.className = 'wb-onboard'
    var h = document.createElement('div')
    h.className = 'wb-onboard-title'
    h.textContent = noBoardsAtAll ? 'No boards yet' : 'No board selected'
    box.appendChild(h)
    var p = document.createElement('div')
    p.className = 'wb-onboard-sub'
    p.textContent = noBoardsAtAll
      ? 'A board is a shared visual document — you edit it here, the agent edits it from chat, and both see the same thing. Create one:'
      : 'Pick a tab above, or add a new board:'
    box.appendChild(p)
    var row = document.createElement('div')
    row.className = 'wb-onboard-row'
    var blurbs = {
      mermaid: 'diagrams (flowchart, sequence, …)',
      table: 'an editable grid',
      chart: 'bar / line / area / scatter / pie / waterfall',
      note: 'a markdown note'
    }
    WB.BOARD_TYPES.forEach(function (type) {
      var card = document.createElement('button')
      card.className = 'wb-onboard-card'
      card.innerHTML =
        '<span class="wb-onboard-glyph">' +
        typeGlyph(type) +
        '</span><span class="wb-onboard-name">' +
        type +
        '</span><span class="wb-onboard-blurb">' +
        blurbs[type] +
        '</span>'
      card.addEventListener('click', function () {
        addBoard(type)
      })
      row.appendChild(card)
    })
    box.appendChild(row)
    var foot = document.createElement('div')
    foot.className = 'wb-onboard-foot'
    foot.textContent = 'Tip: you can also just ask the agent — “put that on a whiteboard chart”.'
    box.appendChild(foot)
    return box
  }

  function renderChartBoard(view, b) {
    var bar = document.createElement('div')
    bar.className = 'wb-table-toolbar'
    var chartHost = document.createElement('div')
    chartHost.className = 'wb-chart-host'

    // Chart-type switcher — visual, not JSON.
    var typeSel = document.createElement('select')
    typeSel.className = 'wb-select'
    WB.CHART_TYPES.forEach(function (t) {
      var opt = document.createElement('option')
      opt.value = t
      opt.textContent = t
      if ((b.chart || 'bar') === t) opt.selected = true
      typeSel.appendChild(opt)
    })
    typeSel.addEventListener('change', function () {
      mutateDoc(function (d) {
        return WB.updateBoard(d, b.id, function (bb) {
          bb.chart = typeSel.value
        })
      }, 'chart-type')
    })
    bar.appendChild(typeSel)

    var editBtn = mkMiniBtn(chartEditorOpen[b.id] ? 'hide data editor' : 'edit data', function () {
      chartEditorOpen[b.id] = !chartEditorOpen[b.id]
      renderActiveBoard()
    })
    if (chartEditorOpen[b.id]) editBtn.classList.add('active')
    bar.appendChild(editBtn)
    view.appendChild(bar)
    view.appendChild(chartHost)

    if (chartEditorOpen[b.id]) {
      view.appendChild(buildChartEditor(b))
    }

    // Defer so clientWidth is known.
    requestAnimationFrame(function () {
      chartHost.innerHTML = ''
      root.WBCharts.renderChart(chartHost, b)
    })
  }

  /* ── chart data editor ────────────────────────────────────────────────
     Edits commit on change (blur/Enter); every commit re-renders the chart.
     Non-scatter: one grid — rows are categories, columns are series.
     Scatter: per-series x/y pair lists. */
  function buildChartEditor(b) {
    var ed = document.createElement('div')
    ed.className = 'wb-chart-editor'

    function commit(mutator, reason) {
      mutateDoc(function (d) {
        return WB.updateBoard(d, b.id, mutator)
      }, reason || 'chart-data')
    }

    // Axis labels.
    var axes = document.createElement('div')
    axes.className = 'wb-ed-row'
    axes.appendChild(edLabel('x label'))
    axes.appendChild(
      edInput((b.x && b.x.label) || '', function (v) {
        commit(function (bb) {
          bb.x = shallow(bb.x || {})
          bb.x.label = v
        })
      })
    )
    axes.appendChild(edLabel('y label'))
    axes.appendChild(
      edInput((b.y && b.y.label) || '', function (v) {
        commit(function (bb) {
          bb.y = shallow(bb.y || {})
          bb.y.label = v
        })
      })
    )
    ed.appendChild(axes)

    var isScatter = (b.chart || 'bar') === 'scatter'
    if (isScatter) {
      buildScatterEditor(ed, b, commit)
    } else {
      buildGridEditor(ed, b, commit)
    }
    return ed
  }

  function buildGridEditor(ed, b, commit) {
    var cats = (b.x && b.x.categories) || []
    var series = Array.isArray(b.series) ? b.series : []
    if ((b.chart || 'bar') === 'pie' || (b.chart || 'bar') === 'waterfall') {
      var note = document.createElement('div')
      note.className = 'wb-ed-note'
      note.textContent =
        b.chart === 'pie'
          ? 'Pie uses the first series only (values vs categories).'
          : 'Waterfall uses the first series as signed deltas; the total bar is computed.'
      ed.appendChild(note)
    }

    var scroll = document.createElement('div')
    scroll.className = 'wb-ed-scroll'
    var table = document.createElement('table')
    table.className = 'wb-grid wb-ed-grid'
    var thead = document.createElement('thead')
    var htr = document.createElement('tr')
    htr.appendChild(edTh((b.x && b.x.label) || 'category'))
    series.forEach(function (s, si) {
      var th = document.createElement('th')
      th.className = 'wb-th'
      var nameInp = edInput(s.name || 'series ' + (si + 1), function (v) {
        commit(function (bb) {
          bb.series = bb.series.map(function (ss, i) {
            if (i !== si) return ss
            var c = shallow(ss)
            c.name = v
            return c
          })
        })
      })
      nameInp.classList.add('wb-ed-series-name')
      th.appendChild(nameInp)
      var del = document.createElement('button')
      del.className = 'wb-mini-btn wb-ed-del'
      del.textContent = '×'
      del.title = 'Remove this series'
      del.addEventListener('click', function () {
        commit(function (bb) {
          bb.series = bb.series.filter(function (_, i) {
            return i !== si
          })
        })
      })
      th.appendChild(del)
      htr.appendChild(th)
    })
    var addTh = document.createElement('th')
    addTh.className = 'wb-th'
    var addSeries = mkMiniBtn('+ series', function () {
      commit(function (bb) {
        var vals = ((bb.x && bb.x.categories) || []).map(function () {
          return 0
        })
        bb.series = (bb.series || []).concat([
          { name: 'series ' + ((bb.series || []).length + 1), values: vals }
        ])
      })
    })
    addTh.appendChild(addSeries)
    htr.appendChild(addTh)
    thead.appendChild(htr)
    table.appendChild(thead)

    var tbody = document.createElement('tbody')
    cats.forEach(function (cat, ri) {
      var tr = document.createElement('tr')
      var catTd = document.createElement('td')
      catTd.className = 'wb-td'
      catTd.appendChild(
        edInput(String(cat), function (v) {
          commit(function (bb) {
            bb.x = shallow(bb.x || {})
            bb.x.categories = (bb.x.categories || []).map(function (cc, i) {
              return i === ri ? v : cc
            })
          })
        })
      )
      tr.appendChild(catTd)
      series.forEach(function (s, si) {
        var td = document.createElement('td')
        td.className = 'wb-td'
        var val = (s.values || [])[ri]
        td.appendChild(
          edInput(val == null ? '' : String(val), function (v) {
            commit(function (bb) {
              bb.series = bb.series.map(function (ss, i) {
                if (i !== si) return ss
                var c = shallow(ss)
                var vals = (c.values || []).slice()
                while (vals.length <= ri) vals.push(0)
                vals[ri] = v.trim() === '' || isNaN(Number(v)) ? v : Number(v)
                c.values = vals
                return c
              })
            })
          })
        )
        tr.appendChild(td)
      })
      var delTd = document.createElement('td')
      delTd.className = 'wb-td wb-ed-rowdel'
      var delRow = document.createElement('button')
      delRow.className = 'wb-mini-btn wb-ed-del'
      delRow.textContent = '×'
      delRow.title = 'Remove this category (and its values)'
      delRow.addEventListener('click', function () {
        commit(function (bb) {
          bb.x = shallow(bb.x || {})
          bb.x.categories = (bb.x.categories || []).filter(function (_, i) {
            return i !== ri
          })
          bb.series = (bb.series || []).map(function (ss) {
            var c = shallow(ss)
            c.values = (c.values || []).filter(function (_, i) {
              return i !== ri
            })
            return c
          })
        })
      })
      delTd.appendChild(delRow)
      tr.appendChild(delTd)
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    scroll.appendChild(table)
    ed.appendChild(scroll)

    var addCat = mkMiniBtn('+ category', function () {
      commit(function (bb) {
        bb.x = shallow(bb.x || {})
        bb.x.categories = (bb.x.categories || []).concat([
          'cat ' + (((bb.x || {}).categories || []).length + 1)
        ])
        bb.series = (bb.series || []).map(function (ss) {
          var c = shallow(ss)
          c.values = (c.values || []).concat([0])
          return c
        })
      })
    })
    var foot = document.createElement('div')
    foot.className = 'wb-ed-row'
    foot.appendChild(addCat)
    ed.appendChild(foot)
  }

  function buildScatterEditor(ed, b, commit) {
    var series = Array.isArray(b.series) ? b.series : []
    series.forEach(function (s, si) {
      var block = document.createElement('div')
      block.className = 'wb-ed-scatter-series'
      var head = document.createElement('div')
      head.className = 'wb-ed-row'
      head.appendChild(
        edInput(s.name || 'series ' + (si + 1), function (v) {
          commit(function (bb) {
            bb.series = bb.series.map(function (ss, i) {
              if (i !== si) return ss
              var c = shallow(ss)
              c.name = v
              return c
            })
          })
        })
      )
      var delS = mkMiniBtn('× series', function () {
        commit(function (bb) {
          bb.series = bb.series.filter(function (_, i) {
            return i !== si
          })
        })
      })
      head.appendChild(delS)
      block.appendChild(head)

      var pts = Array.isArray(s.points) ? s.points : []
      pts.forEach(function (p, pi) {
        var row = document.createElement('div')
        row.className = 'wb-ed-row wb-ed-point'
        ;[0, 1].forEach(function (axis) {
          row.appendChild(edLabel(axis === 0 ? 'x' : 'y'))
          row.appendChild(
            edInput(String((p || [])[axis] != null ? p[axis] : ''), function (v) {
              commit(function (bb) {
                bb.series = bb.series.map(function (ss, i) {
                  if (i !== si) return ss
                  var c = shallow(ss)
                  c.points = (c.points || []).map(function (pp, j) {
                    if (j !== pi) return pp
                    var np = (pp || []).slice()
                    np[axis] = isNaN(Number(v)) ? v : Number(v)
                    return np
                  })
                  return c
                })
              })
            })
          )
        })
        var delP = mkMiniBtn('×', function () {
          commit(function (bb) {
            bb.series = bb.series.map(function (ss, i) {
              if (i !== si) return ss
              var c = shallow(ss)
              c.points = (c.points || []).filter(function (_, j) {
                return j !== pi
              })
              return c
            })
          })
        })
        row.appendChild(delP)
        block.appendChild(row)
      })
      var addP = mkMiniBtn('+ point', function () {
        commit(function (bb) {
          bb.series = bb.series.map(function (ss, i) {
            if (i !== si) return ss
            var c = shallow(ss)
            c.points = (c.points || []).concat([[0, 0]])
            return c
          })
        })
      })
      block.appendChild(addP)
      ed.appendChild(block)
    })
    var addS = mkMiniBtn('+ series', function () {
      commit(function (bb) {
        bb.series = (bb.series || []).concat([
          { name: 'series ' + ((bb.series || []).length + 1), points: [[0, 0]] }
        ])
      })
    })
    ed.appendChild(addS)
  }

  function edLabel(text) {
    var l = document.createElement('span')
    l.className = 'wb-ed-label'
    l.textContent = text
    return l
  }

  // A small input that commits on change (blur/Enter). Commit re-renders the board,
  // which is safe because focus has already left the field.
  function edInput(value, onCommit) {
    var inp = document.createElement('input')
    inp.className = 'wb-ed-input'
    inp.value = value
    inp.addEventListener('change', function () {
      onCommit(inp.value)
    })
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') inp.blur()
      e.stopPropagation()
    })
    return inp
  }

  function edTh(text) {
    var th = document.createElement('th')
    th.className = 'wb-th'
    th.textContent = text
    return th
  }

  /* ── note board: Edit / Split / Preview modes, click-preview-to-edit ── */
  function renderNoteBoard(view, b) {
    var mode = noteModes[b.id] || 'preview'
    var bar = document.createElement('div')
    bar.className = 'wb-table-toolbar'

    var body = document.createElement('div')
    body.className = 'wb-note-body mode-' + mode

    var rendered = document.createElement('div')
    rendered.className = 'wb-note-rendered'
    var ta = document.createElement('textarea')
    ta.className = 'wb-note-editor'
    ta.spellcheck = false
    ta.value = b.markdown || ''
    ta.placeholder = 'Write markdown here…'

    function setMode(m, focus) {
      noteModes[b.id] = m
      mode = m
      body.className = 'wb-note-body mode-' + m
      ;['edit', 'split', 'preview'].forEach(function (mm) {
        var btn = bar.querySelector('[data-mode="' + mm + '"]')
        if (btn) btn.classList.toggle('active', mm === m)
      })
      if (focus && m !== 'preview') ta.focus()
    }
    ;['edit', 'split', 'preview'].forEach(function (m) {
      var btn = mkMiniBtn(m, function () {
        setMode(m, true)
      })
      btn.dataset.mode = m
      if (m === mode) btn.classList.add('active')
      bar.appendChild(btn)
    })

    view.appendChild(bar)
    body.appendChild(ta)
    body.appendChild(rendered)
    view.appendChild(body)

    rendered.innerHTML = root.WBNote.render(b.markdown || '')
    // Click the preview to start editing — the "how do I write in this?" path.
    rendered.addEventListener('click', function (e) {
      if (mode !== 'preview') return
      if (e.target.closest('a')) return
      setMode('split', true)
    })
    if (mode === 'preview' && !(b.markdown || '').trim()) {
      rendered.innerHTML =
        '<div class="wb-empty">Empty note — click here (or “edit”) to start writing.</div>'
    }

    var deb = null
    ta.addEventListener('input', function () {
      rendered.innerHTML = root.WBNote.render(ta.value)
      clearTimeout(deb)
      deb = setTimeout(function () {
        mutateDocSilent(function (d) {
          return WB.updateBoard(d, b.id, function (bb) {
            bb.markdown = ta.value
          })
        }, 'note')
      }, 400)
    })
  }

  // Mermaid insert-snippets — so authoring doesn't require remembering the syntax.
  var MM_SNIPPETS = [
    { label: '+ node', text: '\n  N[Label]' },
    { label: '+ edge', text: '\n  A --> B' },
    { label: '+ labeled edge', text: '\n  A -- label --> B' },
    { label: '+ subgraph', text: '\n  subgraph Group\n    X[Item]\n  end' }
  ]
  var MM_TEMPLATES = {
    flowchart:
      'flowchart TD\n  A[Start] --> B{Decision}\n  B -- yes --> C[Do it]\n  B -- no --> D[Skip]',
    sequence:
      'sequenceDiagram\n  participant U as User\n  participant S as System\n  U->>S: request\n  S-->>U: response',
    state: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Working: start\n  Working --> Idle: done',
    er: 'erDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ ITEM : contains',
    gantt:
      'gantt\n  dateFormat YYYY-MM-DD\n  title Plan\n  section Phase 1\n  Task A :a1, 2026-01-01, 7d\n  Task B :after a1, 5d'
  }

  // A source-editing textarea under a board (mermaid). Debounced persist (silent —
  // re-rendering the board mid-typing would rebuild the textarea and dump focus).
  function appendSourceEditor(view, b, field, label) {
    var sec = document.createElement('div')
    sec.className = 'source-sec'
    var lbl = document.createElement('div')
    lbl.className = 'source-lbl'
    lbl.textContent = label
    var ta = document.createElement('textarea')
    ta.className = 'source-ta'
    ta.spellcheck = false
    ta.value = b[field] || ''

    function refreshAndSave() {
      var tmp = {}
      Object.keys(b).forEach(function (k) {
        tmp[k] = b[k]
      })
      tmp[field] = ta.value
      var host = view.querySelector('.wb-mermaid-host')
      if (host) root.WBMermaid.renderMermaid(host, tmp)
      clearTimeout(deb)
      deb = setTimeout(function () {
        mutateDocSilent(function (d) {
          return WB.updateBoard(d, b.id, function (bb) {
            bb[field] = ta.value
          })
        }, 'source')
      }, 400)
    }

    // Snippet bar: insert at cursor + template picker.
    var snips = document.createElement('div')
    snips.className = 'wb-snippet-bar'
    MM_SNIPPETS.forEach(function (s) {
      snips.appendChild(
        mkMiniBtn(s.label, function () {
          insertAtCursor(ta, s.text)
          refreshAndSave()
        })
      )
    })
    var dirBtn = mkMiniBtn('TD⇄LR', function () {
      ta.value = ta.value.replace(/\b(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/, function (_, kw, d) {
        return kw + ' ' + (d === 'LR' ? 'TD' : 'LR')
      })
      refreshAndSave()
    })
    dirBtn.title = 'Toggle flowchart direction (top-down / left-right)'
    snips.appendChild(dirBtn)
    var tmplSel = document.createElement('select')
    tmplSel.className = 'wb-select'
    var opt0 = document.createElement('option')
    opt0.value = ''
    opt0.textContent = 'template…'
    tmplSel.appendChild(opt0)
    Object.keys(MM_TEMPLATES).forEach(function (k) {
      var o = document.createElement('option')
      o.value = k
      o.textContent = k
      tmplSel.appendChild(o)
    })
    tmplSel.title = 'Insert a starting template (appends when the board already has source)'
    tmplSel.addEventListener('change', function () {
      var k = tmplSel.value
      tmplSel.value = ''
      if (!k) return
      var t = MM_TEMPLATES[k]
      ta.value = ta.value.trim() ? ta.value + '\n\n' + t : t
      refreshAndSave()
    })
    snips.appendChild(tmplSel)

    sec.appendChild(lbl)
    sec.appendChild(snips)
    sec.appendChild(ta)
    view.appendChild(sec)
    var deb = null
    ta.addEventListener('input', refreshAndSave)
  }

  function insertAtCursor(ta, text) {
    var start = ta.selectionStart != null ? ta.selectionStart : ta.value.length
    var end = ta.selectionEnd != null ? ta.selectionEnd : start
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end)
    var pos = start + text.length
    ta.selectionStart = ta.selectionEnd = pos
    ta.focus()
  }

  /* ── Comments thread (under the active board) ─────────────────────── */
  function renderComments() {
    if (malformed) {
      commentsEl.style.display = 'none'
      return
    }
    commentsEl.style.display = ''
    commentsEl.innerHTML = ''
    var b = WB.findBoard(doc, activeId)
    if (!b) return
    var head = document.createElement('div')
    head.className = 'comments-head'
    var comments = Array.isArray(b.comments) ? b.comments : []
    head.textContent = 'Comments (' + comments.length + ')'
    commentsEl.appendChild(head)

    var list = document.createElement('div')
    list.className = 'comments-list'
    comments.forEach(function (c) {
      var row = document.createElement('div')
      row.className = 'comment by-' + (c.by === 'agent' ? 'agent' : 'user')
      var meta = document.createElement('span')
      meta.className = 'comment-meta'
      meta.textContent = (c.by === 'agent' ? 'agent' : 'user') + ' · ' + fmtTs(c.ts)
      var text = document.createElement('div')
      text.className = 'comment-text'
      text.textContent = c.text == null ? '' : String(c.text)
      row.appendChild(meta)
      row.appendChild(text)
      list.appendChild(row)
    })
    commentsEl.appendChild(list)

    var inputRow = document.createElement('div')
    inputRow.className = 'comment-input-row'
    var input = document.createElement('input')
    input.className = 'comment-input'
    input.placeholder = 'Add a comment for the agent…'
    var send = mkMiniBtn('comment', function () {
      var t = input.value.trim()
      if (!t) return
      var id = b.id
      mutateDoc(function (d) {
        return WB.addComment(d, id, 'user', t)
      }, 'comment')
      input.value = ''
    })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        send.click()
      }
    })
    inputRow.appendChild(input)
    inputRow.appendChild(send)
    commentsEl.appendChild(inputRow)
  }

  function fmtTs(ts) {
    if (!ts) return ''
    try {
      var d = new Date(ts)
      return d.toLocaleString()
    } catch (e) {
      return ''
    }
  }

  /* ── Add / rename / delete boards ─────────────────────────────────── */
  function wireAddMenu() {
    addMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      addMenu.classList.toggle('open')
    })
    document.addEventListener('click', function () {
      addMenu.classList.remove('open')
      if (confirmDeleteId) {
        confirmDeleteId = null
        renderTabs()
      }
    })
    WB.BOARD_TYPES.forEach(function (type) {
      var item = document.createElement('div')
      item.className = 'add-item'
      item.textContent = typeGlyph(type) + '  ' + type + ' board'
      item.addEventListener('click', function () {
        addBoard(type)
      })
      addMenu.appendChild(item)
    })
  }

  function addBoard(type) {
    if (malformed) return
    var nb = WB.newBoard(doc, type)
    mutateDoc(function (d) {
      var next = shallow(d)
      next.boards = (d.boards || []).concat([nb])
      return next
    }, 'add-board')
    lastUserTabClick = Date.now()
    activeId = nb.id
    A.storage.set('activeTab', activeId).catch(function () {})
    renderAll()
  }

  // Deletion is confirmed inline in the tab (renderTabs) — never via confirm(),
  // which is a silent no-op in the sandboxed iframe.
  function deleteBoard(id) {
    var b = WB.findBoard(doc, id)
    if (!b) return
    var idx = WB.boardIndex(doc, id)
    mutateDoc(function (d) {
      var next = shallow(d)
      next.boards = (d.boards || []).filter(function (x) {
        return x.id !== id
      })
      return next
    }, 'delete')
    if (activeId === id) {
      var boards = doc.boards
      activeId = boards.length ? boards[Math.min(idx, boards.length - 1)].id : null
      A.storage.set('activeTab', activeId).catch(function () {})
    }
    renderAll()
  }

  /* ── Size guard ───────────────────────────────────────────────────── */
  function updateSizeWarn() {
    if (malformed) {
      sizeWarn.style.display = 'none'
      return
    }
    var info = WB.sizeInfo(doc, MAX_TOKENS)
    if (info.over) {
      sizeWarn.style.display = 'block'
      sizeWarn.textContent =
        '⚠ Boards doc is ' +
        info.chars +
        ' chars, over the ~' +
        info.cap +
        ' budget. Ask the agent to split large tables.'
    } else if (info.near) {
      sizeWarn.style.display = 'block'
      sizeWarn.textContent =
        'Boards doc is ' + info.chars + '/' + info.cap + ' chars — approaching the context budget.'
    } else {
      sizeWarn.style.display = 'none'
    }
  }

  /* ── helpers ──────────────────────────────────────────────────────── */
  function shallow(o) {
    var c = {}
    Object.keys(o).forEach(function (k) {
      c[k] = o[k]
    })
    return c
  }
  function mkMiniBtn(label, fn) {
    var b = document.createElement('button')
    b.className = 'wb-mini-btn'
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }
  function status(t) {
    if (statusEl) statusEl.textContent = t
  }
  function flashBoardArea() {
    boardArea.classList.add('flash')
    setTimeout(function () {
      boardArea.classList.remove('flash')
    }, 600)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})(window)
