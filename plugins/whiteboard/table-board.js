/* ───────────────────────────────────────────────────────────────────────────
   Whiteboard — table board renderer (hand-rolled grid).
   Renders board.{columns, rows, align?, styles?} as an editable grid: click a cell
   to edit (input on click), edits call onEdit(mutator) which the app debounces into
   context.set. Column sort is VIEW-ONLY (does not rewrite doc row order — spec §4).

   Formatting: a "Format" toggle switches clicks from edit to SELECT (shift-click
   extends to a range). The format bar then applies background / text color / bold /
   align to the selection, persisted in board.styles: { "r,c": {bg,color,bold,align} }
   (row/col indexes are DOC order, not view order — sort is display-only). Row/col
   delete lives in format mode too; style keys are remapped by the pure helpers in
   model.js so formatting never drifts onto the wrong cell.

   Empty table: renders a dashed starter panel with a one-click 3×3 seed instead of
   a collapsed sliver.
   ─────────────────────────────────────────────────────────────────────────── */
;(function (root) {
  'use strict'
  var WB = root.WB

  var BG_SWATCHES = ['', '#2d1e1e', '#1e2d22', '#1e232d', '#2d2a1e', '#2a1e2d', '#22262e']
  var FG_SWATCHES = ['', '#f85149', '#3fb950', '#5b9cff', '#e3b341', '#db61a2', '#8892a4']

  function isNumeric(v) {
    if (typeof v === 'number') return true
    var t = String(v == null ? '' : v).trim()
    return t !== '' && !isNaN(Number(t))
  }

  // Per-table view state keyed by board id (sort/selection/format mode — never persisted).
  var viewState = {}

  function vs(board) {
    return (
      viewState[board.id] ||
      (viewState[board.id] = { sortCol: -1, asc: true, fmt: false, sel: null })
    )
  }

  // Selection is { r1, c1, r2, c2 } in DOC coordinates (normalized so r1<=r2, c1<=c2).
  function normSel(sel) {
    if (!sel) return null
    return {
      r1: Math.min(sel.r1, sel.r2),
      r2: Math.max(sel.r1, sel.r2),
      c1: Math.min(sel.c1, sel.c2),
      c2: Math.max(sel.c1, sel.c2)
    }
  }

  function inSel(sel, r, c) {
    var s = normSel(sel)
    return s && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2
  }

  /* render(host, board, onEdit)
       host   — container element (cleared)
       board  — the table board object
       onEdit — (mutator) => void ; called with a function that mutates a CLONE of
                the board; the app builds the next doc + persists. */
  function render(host, board, onEdit) {
    host.innerHTML = ''
    var columns = Array.isArray(board.columns) ? board.columns.slice() : []
    var rows = Array.isArray(board.rows)
      ? board.rows.map(function (r) {
          return (r || []).slice()
        })
      : []
    var align = Array.isArray(board.align) ? board.align : []
    var styles = board.styles && typeof board.styles === 'object' ? board.styles : {}
    var state = vs(board)

    host.appendChild(buildToolbar(host, board, onEdit, state))

    var scroll = document.createElement('div')
    scroll.className = 'wb-table-scroll'
    host.appendChild(scroll)

    if (!columns.length) {
      scroll.appendChild(buildStarter(onEdit))
      return
    }

    var table = document.createElement('table')
    table.className = 'wb-grid'
    var thead = document.createElement('thead')
    var htr = document.createElement('tr')

    columns.forEach(function (col, ci) {
      var th = document.createElement('th')
      th.className = 'wb-th'
      var label = document.createElement('span')
      label.textContent = col == null || col === '' ? 'col' + (ci + 1) : col
      th.appendChild(label)
      if (state.sortCol === ci) {
        var ind = document.createElement('span')
        ind.className = 'wb-sort-ind'
        ind.textContent = state.asc ? ' ▲' : ' ▼'
        th.appendChild(ind)
      }
      th.title = 'Click to sort (view only). Double-click to rename.'
      th.addEventListener('click', function () {
        if (state.sortCol === ci) state.asc = !state.asc
        else {
          state.sortCol = ci
          state.asc = true
        }
        render(host, board, onEdit)
      })
      th.addEventListener('dblclick', function (e) {
        e.stopPropagation()
        editHeader(th, ci, onEdit)
      })
      htr.appendChild(th)
    })
    thead.appendChild(htr)
    table.appendChild(thead)

    // Build a view ordering (sort is display-only; we keep a map to real row idx).
    var order = rows.map(function (_, i) {
      return i
    })
    if (state.sortCol >= 0 && state.sortCol < columns.length) {
      var c = state.sortCol
      var allNum = rows.every(function (r) {
        var v = r[c]
        return v == null || v === '' || isNumeric(v)
      })
      order.sort(function (ia, ib) {
        var a = rows[ia][c],
          b = rows[ib][c]
        var cmp
        if (allNum) cmp = Number(a || 0) - Number(b || 0)
        else
          cmp = String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), undefined, {
            numeric: true,
            sensitivity: 'base'
          })
        return state.asc ? cmp : -cmp
      })
    }

    var tbody = document.createElement('tbody')
    order.forEach(function (realIdx) {
      var r = rows[realIdx]
      var tr = document.createElement('tr')
      columns.forEach(function (_, ci) {
        var td = document.createElement('td')
        td.className = 'wb-td'
        var val = r[ci]
        var st = styles[realIdx + ',' + ci] || {}
        var rightAlign = st.align
          ? st.align === 'right'
          : align[ci]
            ? align[ci] === 'right'
            : isNumeric(val)
        var center = st.align === 'center' || (!st.align && align[ci] === 'center')
        td.style.textAlign = center ? 'center' : rightAlign ? 'right' : 'left'
        if (st.bg) td.style.background = st.bg
        if (st.color) td.style.color = st.color
        if (st.bold) td.style.fontWeight = '600'
        if (state.fmt && inSel(state.sel, realIdx, ci)) td.classList.add('fmt-selected')
        td.textContent = val == null ? '' : String(val)
        td.addEventListener('click', function (e) {
          if (state.fmt) {
            if (e.shiftKey && state.sel) {
              state.sel.r2 = realIdx
              state.sel.c2 = ci
            } else {
              state.sel = { r1: realIdx, c1: ci, r2: realIdx, c2: ci }
            }
            render(host, board, onEdit)
          } else {
            editCell(td, realIdx, ci, onEdit)
          }
        })
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    scroll.appendChild(table)
  }

  /* ── toolbar (add/format controls) ─────────────────────────────────── */
  function buildToolbar(host, board, onEdit, state) {
    var toolbar = document.createElement('div')
    toolbar.className = 'wb-table-toolbar'
    toolbar.appendChild(
      mkBtn('+ row', function () {
        onEdit(function (b) {
          var cols = Array.isArray(b.columns) ? b.columns.length : 0
          var newRow = []
          for (var c = 0; c < cols; c++) newRow.push('')
          b.rows = (Array.isArray(b.rows) ? b.rows.slice() : []).concat([newRow])
        })
      })
    )
    toolbar.appendChild(
      mkBtn('+ column', function () {
        onEdit(function (b) {
          b.columns = (Array.isArray(b.columns) ? b.columns.slice() : []).concat([
            'col' + ((b.columns ? b.columns.length : 0) + 1)
          ])
          b.rows = (Array.isArray(b.rows) ? b.rows : []).map(function (r) {
            return (r || []).concat([''])
          })
        })
      })
    )

    var fmtBtn = mkBtn('format', function () {
      state.fmt = !state.fmt
      if (!state.fmt) state.sel = null
      render(host, board, onEdit)
    })
    fmtBtn.classList.toggle('active', !!state.fmt)
    fmtBtn.title = 'Toggle format mode: click selects cells (shift-click extends), then style them'
    toolbar.appendChild(fmtBtn)

    if (state.fmt) {
      toolbar.appendChild(buildFormatBar(host, board, onEdit, state))
    }
    return toolbar
  }

  function buildFormatBar(host, board, onEdit, state) {
    var bar = document.createElement('span')
    bar.className = 'wb-fmt-bar'
    var sel = normSel(state.sel)

    function applyStyle(patch) {
      if (!sel) return
      onEdit(function (b) {
        var styles = {}
        if (b.styles && typeof b.styles === 'object') {
          Object.keys(b.styles).forEach(function (k) {
            styles[k] = b.styles[k]
          })
        }
        for (var r = sel.r1; r <= sel.r2; r++) {
          for (var c = sel.c1; c <= sel.c2; c++) {
            var key = r + ',' + c
            var cur = styles[key] ? shallowCopy(styles[key]) : {}
            Object.keys(patch).forEach(function (pk) {
              if (patch[pk] === '' || patch[pk] === null) delete cur[pk]
              else cur[pk] = patch[pk]
            })
            if (Object.keys(cur).length) styles[key] = cur
            else delete styles[key]
          }
        }
        if (Object.keys(styles).length) b.styles = styles
        else delete b.styles
      })
    }

    if (!sel) {
      var hint = document.createElement('span')
      hint.className = 'wb-fmt-hint'
      hint.textContent = 'click a cell (shift-click for a range)'
      bar.appendChild(hint)
      return bar
    }

    bar.appendChild(swatchGroup('bg', BG_SWATCHES, applyStyle))
    bar.appendChild(swatchGroup('color', FG_SWATCHES, applyStyle))

    var bold = mkBtn('B', function () {
      // toggle based on the anchor cell's current state
      var anchor = (board.styles || {})[sel.r1 + ',' + sel.c1] || {}
      applyStyle({ bold: anchor.bold ? null : true })
    })
    bold.classList.add('wb-fmt-bold')
    bold.title = 'Bold'
    bar.appendChild(bold)

    var aligns = ['left', 'center', 'right']
    aligns.forEach(function (a) {
      var btn = mkBtn(a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥', function () {
        applyStyle({ align: a })
      })
      btn.title = 'Align ' + a
      bar.appendChild(btn)
    })
    var clr = mkBtn('clear', function () {
      applyStyle({ bg: null, color: null, bold: null, align: null })
    })
    clr.title = 'Clear formatting on the selection'
    bar.appendChild(clr)

    var delRow = mkBtn('− row', function () {
      onEdit(function (b) {
        for (var r = sel.r2; r >= sel.r1; r--) WB.deleteTableRow(b, r)
      })
      state.sel = null
    })
    delRow.title = 'Delete selected row(s)'
    bar.appendChild(delRow)
    var delCol = mkBtn('− col', function () {
      onEdit(function (b) {
        for (var c = sel.c2; c >= sel.c1; c--) WB.deleteTableCol(b, c)
      })
      state.sel = null
    })
    delCol.title = 'Delete selected column(s)'
    bar.appendChild(delCol)
    return bar
  }

  function swatchGroup(prop, colors, applyStyle) {
    var g = document.createElement('span')
    g.className = 'wb-swatches'
    g.title = prop === 'bg' ? 'Cell background' : 'Text color'
    colors.forEach(function (col) {
      var s = document.createElement('button')
      s.className = 'wb-swatch' + (prop === 'color' ? ' fg' : '')
      if (col) {
        if (prop === 'bg') s.style.background = col
        else s.style.color = col
        if (prop === 'color') s.textContent = 'A'
      } else {
        s.classList.add('none')
        s.title = 'none'
      }
      s.addEventListener('click', function () {
        var patch = {}
        patch[prop] = col || null
        applyStyle(patch)
      })
      g.appendChild(s)
    })
    return g
  }

  /* ── empty-table starter ───────────────────────────────────────────── */
  function buildStarter(onEdit) {
    var box = document.createElement('div')
    box.className = 'wb-table-starter'
    var msg = document.createElement('div')
    msg.textContent = 'Empty table'
    box.appendChild(msg)
    var sub = document.createElement('div')
    sub.className = 'wb-starter-sub'
    sub.textContent = 'Seed a starter grid, use “+ column”, or let the agent fill it.'
    box.appendChild(sub)
    var seed = mkBtn('start with a 3×3 grid', function () {
      onEdit(function (b) {
        b.columns = ['col1', 'col2', 'col3']
        b.rows = [
          ['', '', ''],
          ['', '', ''],
          ['', '', '']
        ]
      })
    })
    box.appendChild(seed)
    return box
  }

  /* ── cell / header editing ─────────────────────────────────────────── */
  function editCell(td, rowIdx, colIdx, onEdit) {
    if (td.querySelector('input')) return
    var current = td.textContent
    td.textContent = ''
    var input = document.createElement('input')
    input.className = 'wb-cell-input'
    input.value = current
    td.appendChild(input)
    input.focus()
    input.select()
    var done = false
    function commit(save) {
      if (done) return
      done = true
      if (save && input.value !== current) {
        onEdit(function (b) {
          var rows = (b.rows || []).map(function (rr) {
            return (rr || []).slice()
          })
          while (rows.length <= rowIdx) rows.push([])
          while (rows[rowIdx].length <= colIdx) rows[rowIdx].push('')
          // coerce back to number if it looks numeric AND original column is numeric-ish
          var v = input.value
          rows[rowIdx][colIdx] = isNumeric(v) && v.trim() !== '' ? Number(v) : v
          b.rows = rows
        })
      } else {
        td.textContent = current
      }
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        commit(false)
      }
      e.stopPropagation()
    })
    input.addEventListener('blur', function () {
      commit(true)
    })
  }

  function editHeader(th, colIdx, onEdit) {
    if (th.querySelector('input')) return
    var current = (th.querySelector('span') && th.querySelector('span').textContent) || ''
    th.innerHTML = ''
    var input = document.createElement('input')
    input.className = 'wb-cell-input'
    input.value = current
    th.appendChild(input)
    input.focus()
    input.select()
    var done = false
    function commit(save) {
      if (done) return
      done = true
      if (save) {
        onEdit(function (b) {
          var cols = (b.columns || []).slice()
          while (cols.length <= colIdx) cols.push('')
          cols[colIdx] = input.value
          b.columns = cols
        })
      }
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        commit(false)
      }
      e.stopPropagation()
    })
    input.addEventListener('blur', function () {
      commit(true)
    })
  }

  function shallowCopy(o) {
    var c = {}
    Object.keys(o).forEach(function (k) {
      c[k] = o[k]
    })
    return c
  }

  function mkBtn(label, fn) {
    var b = document.createElement('button')
    b.className = 'wb-mini-btn'
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }

  root.WBTable = { render: render }
})(window)
