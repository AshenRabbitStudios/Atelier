/* ───────────────────────────────────────────────────────────────────────────
   Data Table → Spreadsheet
   Self-contained vanilla JS. No external resources. Backed by the CSV/TSV
   string in context key "table"; every edit re-serializes and persists.
   ─────────────────────────────────────────────────────────────────────────── */
;(function () {
  'use strict'

  /* ── DOM ───────────────────────────────────────────────────────────── */
  var scrollEl = document.getElementById('grid-scroll')
  var hintEl = document.getElementById('hint')
  var statusL = document.getElementById('status-left')
  var statusR = document.getElementById('status-right')
  var cellrefEl = document.getElementById('cellref')
  var fxInput = document.getElementById('formula-input')

  /* ── State ─────────────────────────────────────────────────────────── */
  var rows = [] // array of arrays of strings; rows[0] = header
  var delim = ',' // detected delimiter for round-tripping
  var colCount = 0 // max columns across header + body
  var lastValue = null // last context string we know about
  var sortCol = -1 // (display only state, sort reorders the model)
  var sortAsc = true
  var sel = { r: 0, c: 0 } // selection in BODY coords: r = body row, c = column
  var editing = false // a cell/header editor is open
  var fxFocused = false // formula bar focused
  var cellEls = [] // cellEls[r][c] -> td element (body)
  var letterEls = [] // letterEls[c] -> th.letter
  var nameEls = [] // nameEls[c] -> th.name
  var gutterEls = [] // gutterEls[r] -> td.gutter
  var headerEditing = false // editing a header name cell

  /* ── CSV / TSV parsing ─────────────────────────────────────────────── */
  function detectDelim(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() && lines[i].indexOf('\t') !== -1) return '\t'
    }
    return ','
  }

  function parseLine(line, d) {
    var fields = []
    var i = 0
    var len = line.length
    while (i <= len) {
      if (i === len) {
        fields.push('')
        break
      }
      if (line[i] === '"') {
        i++
        var field = ''
        while (i < len) {
          if (line[i] === '"') {
            if (i + 1 < len && line[i + 1] === '"') {
              field += '"'
              i += 2
            } else {
              i++
              break
            }
          } else {
            field += line[i++]
          }
        }
        fields.push(field)
        if (i < len && line[i] === d) i++
      } else {
        var start = i
        while (i < len && line[i] !== d) i++
        fields.push(line.slice(start, i))
        if (i < len) i++
      }
    }
    return fields
  }

  function parseCSV(text) {
    if (!text || !text.trim()) {
      delim = ','
      return []
    }
    var lines = text.split(/\r?\n/)
    delim = detectDelim(lines)
    var out = []
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      try {
        out.push(parseLine(lines[i], delim))
      } catch (e) {
        out.push([lines[i]])
      }
    }
    return out
  }

  /* ── Serialize back to CSV / TSV ───────────────────────────────────── */
  function needsQuote(s, d) {
    return s.indexOf(d) !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1
  }
  function serialize() {
    var d = delim
    var lines = []
    for (var r = 0; r < rows.length; r++) {
      var cells = []
      var row = rows[r] || []
      for (var c = 0; c < row.length; c++) {
        var v = row[c] == null ? '' : String(row[c])
        if (needsQuote(v, d)) v = '"' + v.replace(/"/g, '""') + '"'
        cells.push(v)
      }
      lines.push(cells.join(d))
    }
    return lines.join('\n')
  }

  /* ── Column / numeric helpers ──────────────────────────────────────── */
  function computeColCount() {
    var n = 0
    for (var r = 0; r < rows.length; r++) {
      if (rows[r] && rows[r].length > n) n = rows[r].length
    }
    colCount = n
  }

  function cellRaw(bodyR, c) {
    var row = rows[bodyR + 1]
    if (!row) return ''
    var v = row[c]
    return v == null ? '' : String(v)
  }

  function isNumStr(s) {
    var t = (s || '').trim()
    return t !== '' && !isNaN(Number(t))
  }

  /* ── Formula engine (tiny, safe, never throws to the UI) ───────────── */
  // Cell refs map to BODY coordinates: A1 = first body row, first column.
  function colLettersToIndex(letters) {
    var n = 0
    for (var i = 0; i < letters.length; i++) {
      n = n * 26 + (letters.charCodeAt(i) - 64)
    }
    return n - 1
  }
  function indexToColLetters(idx) {
    var s = ''
    idx += 1
    while (idx > 0) {
      var m = (idx - 1) % 26
      s = String.fromCharCode(65 + m) + s
      idx = Math.floor((idx - 1) / 26)
    }
    return s
  }
  function parseRef(word) {
    var m = /^([A-Za-z]+)([0-9]+)$/.exec(word)
    if (!m) return null
    return { c: colLettersToIndex(m[1].toUpperCase()), r: parseInt(m[2], 10) - 1 }
  }

  // numeric value of a cell for use inside a formula; throws on cycle.
  function numericValue(bodyR, c, visited) {
    if (bodyR < 0 || c < 0) return 0
    var key = bodyR + ',' + c
    if (visited[key]) throw new Error('cycle')
    var raw = cellRaw(bodyR, c)
    if (raw === '') return 0
    if (raw.charAt(0) === '=') {
      visited[key] = true
      try {
        var val = evalExpr(raw.slice(1), visited)
        return val
      } finally {
        delete visited[key]
      }
    }
    var n = Number(raw.trim())
    return isNaN(n) ? NaN : n
  }

  function tokenize(s) {
    var t = []
    var i = 0
    while (i < s.length) {
      var ch = s[i]
      if (ch === ' ' || ch === '\t') {
        i++
        continue
      }
      if ('+-*/(),:'.indexOf(ch) !== -1) {
        t.push({ t: ch })
        i++
        continue
      }
      if ((ch >= '0' && ch <= '9') || ch === '.') {
        var j = i + 1
        while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++
        t.push({ t: 'num', v: parseFloat(s.slice(i, j)) })
        i = j
        continue
      }
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
        var k = i + 1
        while (
          k < s.length &&
          ((s[k] >= 'A' && s[k] <= 'Z') ||
            (s[k] >= 'a' && s[k] <= 'z') ||
            (s[k] >= '0' && s[k] <= '9'))
        )
          k++
        t.push({ t: 'word', v: s.slice(i, k) })
        i = k
        continue
      }
      throw new Error('badchar')
    }
    return t
  }

  function evalExpr(src, visited) {
    var toks = tokenize(src)
    var pos = 0

    function peek() {
      return toks[pos]
    }
    function next() {
      return toks[pos++]
    }
    function expect(t) {
      var tk = next()
      if (!tk || tk.t !== t) throw new Error('expected ' + t)
    }

    function refCellsInRange(a, b) {
      var r0 = Math.min(a.r, b.r)
      var r1 = Math.max(a.r, b.r)
      var c0 = Math.min(a.c, b.c)
      var c1 = Math.max(a.c, b.c)
      var list = []
      for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) list.push({ r: r, c: c })
      return list
    }

    // Collect numbers for a function argument list (supports ranges).
    function collectArgs() {
      var nums = []
      expect('(')
      if (peek() && peek().t === ')') {
        next()
        return nums
      }
      for (;;) {
        // range?  ref ':' ref
        if (
          peek() &&
          peek().t === 'word' &&
          parseRef(peek().v) &&
          toks[pos + 1] &&
          toks[pos + 1].t === ':'
        ) {
          var a = parseRef(next().v)
          expect(':')
          var b = parseRef(next().v)
          var cells = refCellsInRange(a, b)
          for (var ci = 0; ci < cells.length; ci++) {
            var raw = cellRaw(cells[ci].r, cells[ci].c)
            if (raw === '') continue
            var nv = numericValue(cells[ci].r, cells[ci].c, visited)
            if (!isNaN(nv)) nums.push(nv)
          }
        } else {
          var v = parseExpr()
          if (!isNaN(v)) nums.push(v)
        }
        if (peek() && peek().t === ',') {
          next()
          continue
        }
        break
      }
      expect(')')
      return nums
    }

    function applyFunc(name, nums) {
      var n = name.toUpperCase()
      var i, s
      if (n === 'SUM') {
        s = 0
        for (i = 0; i < nums.length; i++) s += nums[i]
        return s
      }
      if (n === 'AVERAGE' || n === 'AVG' || n === 'MEAN') {
        if (!nums.length) return 0
        s = 0
        for (i = 0; i < nums.length; i++) s += nums[i]
        return s / nums.length
      }
      if (n === 'MIN') {
        if (!nums.length) return 0
        return Math.min.apply(null, nums)
      }
      if (n === 'MAX') {
        if (!nums.length) return 0
        return Math.max.apply(null, nums)
      }
      if (n === 'COUNT') return nums.length
      if (n === 'PRODUCT') {
        s = 1
        for (i = 0; i < nums.length; i++) s *= nums[i]
        return s
      }
      throw new Error('unknown fn ' + n)
    }

    function parseFactor() {
      var tk = peek()
      if (!tk) throw new Error('eof')
      if (tk.t === '-') {
        next()
        return -parseFactor()
      }
      if (tk.t === '+') {
        next()
        return parseFactor()
      }
      if (tk.t === '(') {
        next()
        var v = parseExpr()
        expect(')')
        return v
      }
      if (tk.t === 'num') {
        next()
        return tk.v
      }
      if (tk.t === 'word') {
        // function call?
        if (toks[pos + 1] && toks[pos + 1].t === '(') {
          var name = next().v
          var nums = collectArgs()
          return applyFunc(name, nums)
        }
        // cell ref
        var ref = parseRef(tk.v)
        if (!ref) throw new Error('bad ref ' + tk.v)
        next()
        return numericValue(ref.r, ref.c, visited)
      }
      throw new Error('unexpected')
    }

    function parseTerm() {
      var v = parseFactor()
      for (;;) {
        var tk = peek()
        if (tk && tk.t === '*') {
          next()
          v = v * parseFactor()
        } else if (tk && tk.t === '/') {
          next()
          v = v / parseFactor()
        } else break
      }
      return v
    }

    function parseExpr() {
      var v = parseTerm()
      for (;;) {
        var tk = peek()
        if (tk && tk.t === '+') {
          next()
          v = v + parseTerm()
        } else if (tk && tk.t === '-') {
          next()
          v = v - parseTerm()
        } else break
      }
      return v
    }

    var result = parseExpr()
    if (pos !== toks.length) throw new Error('trailing tokens')
    return result
  }

  function fmtNumber(n) {
    if (!isFinite(n)) return '#ERR'
    if (Number.isInteger(n)) return String(n)
    var r = Math.round(n * 1e6) / 1e6
    return String(r)
  }

  // Display info for a body cell: { text, numeric, value, isFormula, isErr }
  function displayCell(bodyR, c) {
    var raw = cellRaw(bodyR, c)
    if (raw.charAt(0) === '=') {
      var v
      try {
        v = evalExpr(raw.slice(1), {})
      } catch (e) {
        return { text: '#ERR', numeric: false, value: NaN, isFormula: true, isErr: true }
      }
      if (typeof v !== 'number' || isNaN(v) || !isFinite(v)) {
        return { text: '#ERR', numeric: false, value: NaN, isFormula: true, isErr: true }
      }
      return { text: fmtNumber(v), numeric: true, value: v, isFormula: true, isErr: false }
    }
    if (isNumStr(raw)) {
      return { text: raw, numeric: true, value: Number(raw.trim()), isFormula: false, isErr: false }
    }
    return { text: raw, numeric: false, value: NaN, isFormula: false, isErr: false }
  }

  // Is a column mostly numeric (by displayed value)?  Used for alignment + heat.
  function columnStats(c) {
    var body = rows.length - 1
    var numericCount = 0
    var nonEmpty = 0
    var min = Infinity
    var max = -Infinity
    for (var r = 0; r < body; r++) {
      var d = displayCell(r, c)
      if (d.text === '') continue
      nonEmpty++
      if (d.numeric) {
        numericCount++
        if (d.value < min) min = d.value
        if (d.value > max) max = d.value
      }
    }
    var numeric = nonEmpty > 0 && numericCount === nonEmpty
    return { numeric: numeric, min: min, max: max }
  }

  /* ── Render ────────────────────────────────────────────────────────── */
  function render() {
    computeColCount()
    cellEls = []
    letterEls = []
    nameEls = []
    gutterEls = []

    // Empty state
    if (rows.length === 0 || colCount === 0) {
      scrollEl.querySelector('table#grid') && scrollEl.querySelector('table#grid').remove()
      hintEl.style.display = 'block'
      hintEl.textContent =
        'No data yet — the spreadsheet is backed by the agent’s CSV/TSV.\n\n' +
        'Expected format (CSV):\n' +
        '  name,role,score\n' +
        '  Ada,lead,42\n' +
        '  Charlie,eng,17\n\n' +
        'TSV auto-detected (use tabs). Quoted fields may contain commas;\n' +
        'use "" for a literal quote inside "…".\n\n' +
        'Tip: start a cell with “=” for a formula, e.g. =SUM(A1:A3) or =A1+B2.'
      statusR.textContent = ''
      updateFormulaBar()
      return
    }
    hintEl.style.display = 'none'

    var header = rows[0] || []

    // Per-column numeric stats (computed once).
    var stats = []
    for (var c = 0; c < colCount; c++) stats.push(columnStats(c))

    var old = scrollEl.querySelector('table#grid')
    if (old) old.remove()

    var tbl = document.createElement('table')
    tbl.id = 'grid'

    // ── header: letter row + name row ──
    var thead = document.createElement('thead')

    var letterRow = document.createElement('tr')
    var corner = document.createElement('th')
    corner.className = 'corner'
    corner.rowSpan = 2
    corner.title = 'Rows × Cols'
    letterRow.appendChild(corner)

    for (var c2 = 0; c2 < colCount; c2++) {
      var lt = document.createElement('th')
      lt.className = 'letter'
      lt.textContent = indexToColLetters(c2)
      ;(function (ci) {
        lt.addEventListener('click', function () {
          doSort(ci)
        })
      })(c2)
      letterRow.appendChild(lt)
      letterEls.push(lt)
    }
    thead.appendChild(letterRow)

    var nameRow = document.createElement('tr')
    for (var c3 = 0; c3 < colCount; c3++) {
      var nm = document.createElement('th')
      nm.className = 'name' + (stats[c3].numeric ? ' num' : '')
      var box = document.createElement('div')
      box.className = 'cellbox'
      var label = document.createElement('span')
      label.textContent = header[c3] != null && header[c3] !== '' ? header[c3] : 'col' + (c3 + 1)
      box.appendChild(label)
      if (sortCol === c3) {
        var ind = document.createElement('span')
        ind.className = 'sort-ind'
        ind.textContent = sortAsc ? '▲' : '▼'
        box.appendChild(ind)
      }
      nm.appendChild(box)
      ;(function (ci, thEl) {
        thEl.addEventListener('click', function () {
          doSort(ci)
        })
        thEl.addEventListener('dblclick', function (e) {
          e.stopPropagation()
          startHeaderEdit(ci)
        })
      })(c3, nm)
      nameRow.appendChild(nm)
      nameEls.push(nm)
    }
    thead.appendChild(nameRow)
    tbl.appendChild(thead)

    // ── body ──
    var tbody = document.createElement('tbody')
    var bodyCount = rows.length - 1
    for (var r = 0; r < bodyCount; r++) {
      var tr = document.createElement('tr')
      if (r % 2 === 1) tr.className = 'even'

      var g = document.createElement('td')
      g.className = 'gutter'
      g.textContent = String(r + 1)
      tr.appendChild(g)
      gutterEls.push(g)

      var rowEls = []
      for (var c4 = 0; c4 < colCount; c4++) {
        var td = document.createElement('td')
        td.className = 'cell'
        var d = displayCell(r, c4)
        var cb = document.createElement('div')
        cb.className = 'cellbox'

        // data-bar heat (numeric columns with a spread)
        if (
          stats[c4].numeric &&
          d.numeric &&
          isFinite(stats[c4].min) &&
          stats[c4].max > stats[c4].min
        ) {
          var frac = (d.value - stats[c4].min) / (stats[c4].max - stats[c4].min)
          if (frac < 0) frac = 0
          if (frac > 1) frac = 1
          var bar = document.createElement('div')
          bar.className = 'bar'
          bar.style.width = (frac * 100).toFixed(1) + '%'
          cb.appendChild(bar)
        }

        var valSpan = document.createElement('span')
        valSpan.className = 'val'
        valSpan.textContent = d.text
        cb.appendChild(valSpan)
        td.appendChild(cb)

        if (stats[c4].numeric || d.numeric) td.classList.add('num')
        if (d.numeric && d.value < 0) td.classList.add('neg')
        if (d.isFormula) td.classList.add('formula')
        if (d.isErr) td.classList.add('err')
        if (d.isFormula && !d.isErr) td.title = cellRaw(r, c4)

        ;(function (rr, cc, tdEl) {
          tdEl.addEventListener('mousedown', function () {
            if (editing) commitEdit(true)
            setSelection(rr, cc)
          })
          tdEl.addEventListener('dblclick', function () {
            setSelection(rr, cc)
            startEdit('')
          })
        })(r, c4, td)

        tr.appendChild(td)
        rowEls.push(td)
      }
      tbody.appendChild(tr)
      cellEls.push(rowEls)
    }
    tbl.appendChild(tbody)
    scrollEl.appendChild(tbl)

    // fix sticky offset of the name row to sit under the letter row
    var lh = letterEls.length ? letterEls[0].getBoundingClientRect().height : 18
    for (var i = 0; i < nameEls.length; i++) nameEls[i].style.top = lh + 'px'

    statusR.textContent =
      bodyCount +
      ' row' +
      (bodyCount !== 1 ? 's' : '') +
      ' × ' +
      colCount +
      ' col' +
      (colCount !== 1 ? 's' : '')

    clampSelection()
    paintSelection()
    updateFormulaBar()
  }

  /* ── Selection ─────────────────────────────────────────────────────── */
  function clampSelection() {
    var bodyCount = rows.length - 1
    if (sel.r < 0) sel.r = 0
    if (sel.c < 0) sel.c = 0
    if (sel.r > bodyCount - 1) sel.r = Math.max(0, bodyCount - 1)
    if (sel.c > colCount - 1) sel.c = Math.max(0, colCount - 1)
  }

  function paintSelection() {
    for (var r = 0; r < cellEls.length; r++)
      for (var c = 0; c < cellEls[r].length; c++) cellEls[r][c].classList.remove('selected')
    for (var i = 0; i < gutterEls.length; i++) gutterEls[i].classList.remove('active')
    for (var j = 0; j < letterEls.length; j++) letterEls[j].classList.remove('active')
    for (var k = 0; k < nameEls.length; k++) nameEls[k].classList.remove('active')

    if (cellEls[sel.r] && cellEls[sel.r][sel.c]) {
      cellEls[sel.r][sel.c].classList.add('selected')
    }
    if (gutterEls[sel.r]) gutterEls[sel.r].classList.add('active')
    if (letterEls[sel.c]) letterEls[sel.c].classList.add('active')
    if (nameEls[sel.c]) nameEls[sel.c].classList.add('active')
  }

  function setSelection(r, c) {
    sel.r = r
    sel.c = c
    clampSelection()
    paintSelection()
    updateFormulaBar()
    scrollSelIntoView()
  }

  function scrollSelIntoView() {
    var el = cellEls[sel.r] && cellEls[sel.r][sel.c]
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  function moveSelection(dr, dc) {
    var bodyCount = rows.length - 1
    var nr = sel.r + dr
    var nc = sel.c + dc
    if (nr < 0) nr = 0
    if (nr > bodyCount - 1) nr = bodyCount - 1
    if (nc < 0) nc = 0
    if (nc > colCount - 1) nc = colCount - 1
    setSelection(nr, nc)
  }

  function updateFormulaBar() {
    if (rows.length <= 1 || colCount === 0) {
      cellrefEl.textContent = '—'
      if (!fxFocused) fxInput.value = ''
      fxInput.disabled = true
      return
    }
    fxInput.disabled = false
    cellrefEl.textContent = indexToColLetters(sel.c) + (sel.r + 1)
    if (!fxFocused) fxInput.value = cellRaw(sel.r, sel.c)
  }

  /* ── Editing (in-cell) ─────────────────────────────────────────────── */
  function ensureRow(bodyR) {
    while (rows.length < bodyR + 2) rows.push([])
    var row = rows[bodyR + 1]
    while (row.length < colCount) row.push('')
    return row
  }

  function startEdit(initial) {
    if (editing || headerEditing) return
    var td = cellEls[sel.r] && cellEls[sel.r][sel.c]
    if (!td) return
    editing = true
    var current = initial != null && initial !== '' ? initial : cellRaw(sel.r, sel.c)
    td.innerHTML = ''
    var input = document.createElement('input')
    input.className = 'editor'
    input.type = 'text'
    input.value = current
    td.appendChild(input)
    input.focus()
    if (initial) {
      // typed-to-edit: caret at end
      input.setSelectionRange(input.value.length, input.value.length)
    } else {
      input.select()
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitEdit(true)
        moveSelection(e.shiftKey ? -1 : 1, 0)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        commitEdit(true)
        moveSelection(0, e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelEdit()
      }
      e.stopPropagation()
    })
    input.addEventListener('blur', function () {
      if (editing) commitEdit(true)
    })
  }

  function commitEdit(persist) {
    if (!editing) return
    var td = cellEls[sel.r] && cellEls[sel.r][sel.c]
    var input = td && td.querySelector('input.editor')
    var newVal = input ? input.value : ''
    editing = false
    var row = ensureRow(sel.r)
    row[sel.c] = newVal
    render()
    if (persist) scheduleSave('edited')
  }

  function cancelEdit() {
    if (!editing) return
    editing = false
    render()
  }

  /* ── Editing (header name) ─────────────────────────────────────────── */
  function startHeaderEdit(c) {
    if (editing || headerEditing) return
    var th = nameEls[c]
    if (!th) return
    headerEditing = true
    var current = rows[0] && rows[0][c] != null ? rows[0][c] : ''
    th.innerHTML = ''
    var input = document.createElement('input')
    input.className = 'editor'
    input.type = 'text'
    input.value = current
    th.appendChild(input)
    input.focus()
    input.select()

    function finish(save) {
      headerEditing = false
      if (save) {
        if (!rows[0]) rows[0] = []
        while (rows[0].length < colCount) rows[0].push('')
        rows[0][c] = input.value
      }
      render()
      if (save) scheduleSave('header')
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
      e.stopPropagation()
    })
    input.addEventListener('blur', function () {
      if (headerEditing) finish(true)
    })
  }

  /* ── Sorting (reorders the model so refs / row numbers stay coherent) ── */
  function doSort(c) {
    if (editing) commitEdit(true)
    if (rows.length <= 2) return
    if (sortCol === c) sortAsc = !sortAsc
    else {
      sortCol = c
      sortAsc = true
    }
    var header = rows[0]
    var body = rows.slice(1)
    // numeric-aware using displayed values
    var stat = columnStats(c)
    body.sort(function (a, b) {
      var ra = a[c] == null ? '' : String(a[c])
      var rb = b[c] == null ? '' : String(b[c])
      var cmp
      if (stat.numeric) {
        var na = Number((ra.charAt(0) === '=' ? '' : ra).trim())
        var nb = Number((rb.charAt(0) === '=' ? '' : rb).trim())
        if (isNaN(na)) na = 0
        if (isNaN(nb)) nb = 0
        cmp = na - nb
      } else {
        cmp = ra.localeCompare(rb, undefined, { sensitivity: 'base', numeric: true })
      }
      return sortAsc ? cmp : -cmp
    })
    rows = [header].concat(body)
    render()
    scheduleSave('sorted')
  }

  /* ── Persistence (debounced) ───────────────────────────────────────── */
  var saveTimer = null
  function scheduleSave(reason) {
    clearTimeout(saveTimer)
    statusL.textContent = '…' + (reason || 'edited')
    saveTimer = setTimeout(function () {
      var val = serialize()
      lastValue = val
      window.atelier.context
        .set('table', val)
        .then(function () {
          statusL.textContent = 'saved ✓'
        })
        .catch(function (e) {
          statusL.textContent = 'save error: ' + (e && e.message)
        })
    }, 400)
  }

  /* ── Formula bar wiring ────────────────────────────────────────────── */
  fxInput.addEventListener('focus', function () {
    fxFocused = true
  })
  fxInput.addEventListener('blur', function () {
    fxFocused = false
    updateFormulaBar()
  })
  fxInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (rows.length > 1 && colCount > 0) {
        var row = ensureRow(sel.r)
        row[sel.c] = fxInput.value
        fxFocused = false
        render()
        scheduleSave('formula-bar')
        moveSelection(1, 0)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      fxFocused = false
      updateFormulaBar()
      fxInput.blur()
    }
  })

  /* ── Global keyboard (navigation + typed-to-edit) ──────────────────── */
  document.addEventListener('keydown', function (e) {
    if (editing || headerEditing || fxFocused) return
    if (rows.length <= 1 || colCount === 0) return

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault()
        moveSelection(-1, 0)
        return
      case 'ArrowDown':
        e.preventDefault()
        moveSelection(1, 0)
        return
      case 'ArrowLeft':
        e.preventDefault()
        moveSelection(0, -1)
        return
      case 'ArrowRight':
        e.preventDefault()
        moveSelection(0, 1)
        return
      case 'Tab':
        e.preventDefault()
        moveSelection(0, e.shiftKey ? -1 : 1)
        return
      case 'Enter':
      case 'F2':
        e.preventDefault()
        startEdit('')
        return
      case 'Backspace':
      case 'Delete':
        e.preventDefault()
        {
          var row = ensureRow(sel.r)
          row[sel.c] = ''
          render()
          scheduleSave('cleared')
        }
        return
      default:
        break
    }
    // typed-to-edit: a single printable char (not a shortcut) starts editing
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      startEdit(e.key)
    }
  })

  /* ── Load context value into the model ─────────────────────────────── */
  function applyValue(text) {
    rows = parseCSV(text || '')
    sortCol = -1
    sortAsc = true
    render()
  }

  /* ── Poll for agent updates ────────────────────────────────────────── */
  setInterval(function () {
    if (editing || headerEditing || fxFocused) return
    window.atelier.context
      .get('table')
      .then(function (val) {
        var v = typeof val === 'string' ? val : ''
        if (v !== lastValue) {
          lastValue = v
          applyValue(v)
          statusL.textContent = 'updated by agent'
        }
      })
      .catch(function () {})
  }, 1500)

  /* ── On load: rebuild from context (treat every mount as a restore) ── */
  window.atelier.on('load', function () {
    statusL.textContent = 'loading…'
    window.atelier.context
      .get('table')
      .then(function (val) {
        var v = typeof val === 'string' ? val : ''
        lastValue = v
        applyValue(v)
        statusL.textContent = v.trim() ? 'ready' : 'ready — waiting for agent data'
      })
      .catch(function (e) {
        statusL.textContent = 'error: ' + (e && e.message)
        applyValue('')
      })
  })
})()
