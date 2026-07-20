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
      var glyph = document.createElement('span')
      glyph.className = 'tab-glyph'
      glyph.textContent = typeGlyph(b.type)
      glyph.title = b.type
      var label = document.createElement('span')
      label.className = 'tab-label'
      label.textContent = b.title || b.id
      tab.appendChild(glyph)
      tab.appendChild(label)
      tab.addEventListener('click', function () {
        lastUserTabClick = Date.now()
        activeId = b.id
        A.storage.set('activeTab', activeId).catch(function () {})
        renderAll()
      })
      tab.addEventListener('dblclick', function () {
        renameBoard(b.id)
      })
      // delete button
      var del = document.createElement('span')
      del.className = 'tab-del'
      del.textContent = '×'
      del.title = 'Delete board'
      del.addEventListener('click', function (e) {
        e.stopPropagation()
        deleteBoard(b.id)
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
      var empty = document.createElement('div')
      empty.className = 'wb-empty'
      empty.textContent = 'No board selected. Use “+” to add one, or the agent can push boards.'
      boardArea.appendChild(empty)
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

  function renderChartBoard(view, b) {
    var bar = document.createElement('div')
    bar.className = 'wb-table-toolbar'
    var asTable = false
    var chartHost = document.createElement('div')
    chartHost.className = 'wb-chart-host'
    var toggle = mkMiniBtn('view as table', function () {
      asTable = !asTable
      draw()
      toggle.textContent = asTable ? 'view as chart' : 'view as table'
    })
    bar.appendChild(toggle)
    view.appendChild(bar)
    view.appendChild(chartHost)

    function draw() {
      chartHost.innerHTML = ''
      if (asTable) {
        renderChartAsTable(chartHost, b)
      } else {
        root.WBCharts.renderChart(chartHost, b)
      }
    }
    // Defer so clientWidth is known.
    requestAnimationFrame(draw)
  }

  function renderChartAsTable(host, b) {
    var cats = (b.x && b.x.categories) || []
    var series = Array.isArray(b.series) ? b.series : []
    var table = document.createElement('table')
    table.className = 'wb-grid'
    var thead = document.createElement('thead')
    var htr = document.createElement('tr')
    var isScatter = b.chart === 'scatter'
    if (isScatter) {
      ;['series', 'x', 'y'].forEach(function (h) {
        var th = document.createElement('th')
        th.className = 'wb-th'
        th.textContent = h
        htr.appendChild(th)
      })
    } else {
      var c0 = document.createElement('th')
      c0.className = 'wb-th'
      c0.textContent = (b.x && b.x.label) || 'category'
      htr.appendChild(c0)
      series.forEach(function (s) {
        var th = document.createElement('th')
        th.className = 'wb-th'
        th.textContent = s.name
        htr.appendChild(th)
      })
    }
    thead.appendChild(htr)
    table.appendChild(thead)
    var tbody = document.createElement('tbody')
    if (isScatter) {
      series.forEach(function (s) {
        ;(s.points || []).forEach(function (p) {
          var tr = document.createElement('tr')
          ;[s.name, p[0], p[1]].forEach(function (v) {
            var td = document.createElement('td')
            td.className = 'wb-td'
            td.textContent = String(v)
            tr.appendChild(td)
          })
          tbody.appendChild(tr)
        })
      })
    } else {
      cats.forEach(function (cat, i) {
        var tr = document.createElement('tr')
        var td0 = document.createElement('td')
        td0.className = 'wb-td'
        td0.textContent = String(cat)
        tr.appendChild(td0)
        series.forEach(function (s) {
          var td = document.createElement('td')
          td.className = 'wb-td'
          td.style.textAlign = 'right'
          td.textContent = String((s.values || [])[i] != null ? (s.values || [])[i] : '')
          tr.appendChild(td)
        })
        tbody.appendChild(tr)
      })
    }
    table.appendChild(tbody)
    var scroll = document.createElement('div')
    scroll.className = 'wb-table-scroll'
    scroll.appendChild(table)
    host.appendChild(scroll)
  }

  function renderNoteBoard(view, b) {
    var bar = document.createElement('div')
    bar.className = 'wb-table-toolbar'
    var editing = false
    var rendered = document.createElement('div')
    rendered.className = 'wb-note-rendered'
    var ta = document.createElement('textarea')
    ta.className = 'wb-note-editor'
    ta.spellcheck = false
    ta.style.display = 'none'
    ta.value = b.markdown || ''

    var toggle = mkMiniBtn('edit markdown', function () {
      editing = !editing
      rendered.style.display = editing ? 'none' : 'block'
      ta.style.display = editing ? 'block' : 'none'
      toggle.textContent = editing ? 'preview' : 'edit markdown'
      if (editing) ta.focus()
    })
    bar.appendChild(toggle)
    view.appendChild(bar)
    view.appendChild(rendered)
    view.appendChild(ta)

    rendered.innerHTML = root.WBNote.render(b.markdown || '')

    var deb = null
    ta.addEventListener('input', function () {
      rendered.innerHTML = root.WBNote.render(ta.value)
      clearTimeout(deb)
      deb = setTimeout(function () {
        mutateDoc(function (d) {
          return WB.updateBoard(d, b.id, function (bb) {
            bb.markdown = ta.value
          })
        }, 'note')
      }, 400)
    })
  }

  // A source-editing textarea under a board (mermaid). Debounced persist.
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
    sec.appendChild(lbl)
    sec.appendChild(ta)
    view.appendChild(sec)
    var deb = null
    ta.addEventListener('input', function () {
      // live re-render for mermaid
      var tmp = {}
      Object.keys(b).forEach(function (k) {
        tmp[k] = b[k]
      })
      tmp[field] = ta.value
      var host = view.querySelector('.wb-mermaid-host')
      if (host) root.WBMermaid.renderMermaid(host, tmp)
      clearTimeout(deb)
      deb = setTimeout(function () {
        mutateDoc(function (d) {
          return WB.updateBoard(d, b.id, function (bb) {
            bb[field] = ta.value
          })
        }, 'source')
      }, 400)
    })
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

  function renameBoard(id) {
    var b = WB.findBoard(doc, id)
    if (!b) return
    var name = prompt('Rename board', b.title || b.id)
    if (name == null) return
    mutateDoc(function (d) {
      return WB.updateBoard(d, id, function (bb) {
        bb.title = name
      })
    }, 'rename')
  }

  function deleteBoard(id) {
    var b = WB.findBoard(doc, id)
    if (!b) return
    if (!confirm('Delete board "' + (b.title || id) + '"? This cannot be undone.')) return
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
