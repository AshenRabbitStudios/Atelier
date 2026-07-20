/* ───────────────────────────────────────────────────────────────────────────
   Whiteboard — table board renderer (hand-rolled grid).
   Renders board.{columns, rows, align?} as an editable grid: click a cell to edit
   (input on click), edits call onEdit(newBoard) which the app debounces into
   context.set. Column sort is VIEW-ONLY (does not rewrite doc row order — spec §4).
   Add row / add column. Numbers right-aligned by default; `align` overrides.
   ─────────────────────────────────────────────────────────────────────────── */
;(function (root) {
  'use strict'

  function isNumeric(v) {
    if (typeof v === 'number') return true
    var t = String(v == null ? '' : v).trim()
    return t !== '' && !isNaN(Number(t))
  }

  // Per-table view state keyed by board id (sort only — never persisted).
  var viewState = {}

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
    var vs = viewState[board.id] || (viewState[board.id] = { sortCol: -1, asc: true })

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
    host.appendChild(toolbar)

    var scroll = document.createElement('div')
    scroll.className = 'wb-table-scroll'
    host.appendChild(scroll)

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
      if (vs.sortCol === ci) {
        var ind = document.createElement('span')
        ind.className = 'wb-sort-ind'
        ind.textContent = vs.asc ? ' ▲' : ' ▼'
        th.appendChild(ind)
      }
      th.title = 'Click to sort (view only). Double-click to rename.'
      th.addEventListener('click', function () {
        if (vs.sortCol === ci) vs.asc = !vs.asc
        else {
          vs.sortCol = ci
          vs.asc = true
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
    if (vs.sortCol >= 0 && vs.sortCol < columns.length) {
      var c = vs.sortCol
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
        return vs.asc ? cmp : -cmp
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
        var rightAlign = align[ci] ? align[ci] === 'right' : isNumeric(val)
        var center = align[ci] === 'center'
        td.style.textAlign = center ? 'center' : rightAlign ? 'right' : 'left'
        td.textContent = val == null ? '' : String(val)
        td.addEventListener('click', function () {
          editCell(td, realIdx, ci, onEdit)
        })
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    scroll.appendChild(table)

    if (!columns.length) {
      var hint = document.createElement('div')
      hint.className = 'wb-empty'
      hint.textContent =
        'Empty table — use “+ column” / “+ row”, or the agent can set columns/rows.'
      scroll.appendChild(hint)
    }
  }

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

  function mkBtn(label, fn) {
    var b = document.createElement('button')
    b.className = 'wb-mini-btn'
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }

  root.WBTable = { render: render }
})(window)
