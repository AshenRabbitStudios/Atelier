/* ───────────────────────────────────────────────────────────────────────────
   Whiteboard — model + sync helpers (pure, no DOM, unit-testable in node)

   The context key "boards" holds a JSON document:
     { active?: string, boards: Board[], ...unknownTopLevelFields }
   Board = { id, title, type: "mermaid"|"table"|"chart"|"note", comments?, ...typeFields, ...unknown }

   Discipline enforced here (spec §2, §5):
     - parse() never throws and never returns {}; a malformed export is reported
       (ok:false) with the raw text so the pane can show a non-destructive banner.
     - Unknown fields (top-level and per-board) are PRESERVED on every serialize.
     - Merge helpers mutate the in-memory doc immutably-ish (return new doc) so a
       remote change can be reconciled around an open editor.
   This module is loaded both as a <script> (attaches window.WB) and via require()
   in a node harness (module.exports), so it stays framework-free.
   ─────────────────────────────────────────────────────────────────────────── */
;(function (root, factory) {
  var api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.WB = api
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  var BOARD_TYPES = ['mermaid', 'table', 'chart', 'note']
  var CHART_TYPES = ['bar', 'line', 'area', 'scatter', 'pie']

  /* Parse the context value. Accepts a JSON string or an already-parsed object
     (the host may hand back either). Returns:
       { ok: true,  doc: {active?, boards: []} }
       { ok: false, raw: "<original text>", error: "<message>" }
     Never throws. Never yields {} on malformed input — the caller keeps the raw. */
  function parse(value) {
    if (value == null || value === '') {
      return { ok: true, doc: { boards: [] } }
    }
    var obj
    if (typeof value === 'string') {
      var t = value.trim()
      if (!t) return { ok: true, doc: { boards: [] } }
      try {
        obj = JSON.parse(t)
      } catch (e) {
        return { ok: false, raw: value, error: (e && e.message) || 'invalid JSON' }
      }
    } else if (typeof value === 'object') {
      obj = value
    } else {
      return { ok: false, raw: String(value), error: 'export is not an object' }
    }

    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, raw: stringify0(value), error: 'top level must be an object' }
    }
    if (!('boards' in obj)) {
      // Tolerate a doc that only carries `active` or unknown fields; treat missing
      // boards as an empty list but keep everything else.
      obj = shallow(obj)
      obj.boards = []
    }
    if (!Array.isArray(obj.boards)) {
      return { ok: false, raw: stringify0(value), error: '"boards" must be an array' }
    }
    // Light per-board sanity: drop nothing, but coerce non-objects to a note so the
    // pane can still show them without crashing. Never destroys data silently — a
    // non-object board is wrapped, keeping its raw form in `_raw`.
    var boards = obj.boards.map(function (b, i) {
      if (b && typeof b === 'object' && !Array.isArray(b)) return b
      return {
        id: 'raw-' + i,
        title: 'Unparsed board ' + (i + 1),
        type: 'note',
        markdown: '',
        _raw: b
      }
    })
    var doc = shallow(obj)
    doc.boards = boards
    return { ok: true, doc: doc }
  }

  function stringify0(v) {
    try {
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    } catch (e) {
      return String(v)
    }
  }

  /* Serialize a doc back to a pretty JSON string, preserving unknown fields and a
     stable-ish key order (active first, then boards, then any extras). */
  function serialize(doc) {
    var out = {}
    if (doc && doc.active != null) out.active = doc.active
    // Preserve other top-level unknowns (except boards/active which we place explicitly).
    if (doc) {
      Object.keys(doc).forEach(function (k) {
        if (k === 'active' || k === 'boards') return
        out[k] = doc[k]
      })
    }
    out.boards = (doc && doc.boards) || []
    return JSON.stringify(out, null, 2)
  }

  function shallow(o) {
    var c = {}
    Object.keys(o).forEach(function (k) {
      c[k] = o[k]
    })
    return c
  }

  function findBoard(doc, id) {
    if (!doc || !doc.boards) return null
    for (var i = 0; i < doc.boards.length; i++) {
      if (doc.boards[i].id === id) return doc.boards[i]
    }
    return null
  }

  function boardIndex(doc, id) {
    if (!doc || !doc.boards) return -1
    for (var i = 0; i < doc.boards.length; i++) {
      if (doc.boards[i].id === id) return i
    }
    return -1
  }

  /* Produce a fresh doc with `board` (matched by id) replaced by the result of
     mutator(clonedBoard). The board clone is shallow but preserves unknown fields;
     mutator edits the clone in place. Returns a new doc object (new boards array). */
  function updateBoard(doc, id, mutator) {
    var boards = (doc.boards || []).map(function (b) {
      if (b.id !== id) return b
      var clone = shallow(b)
      mutator(clone)
      return clone
    })
    var next = shallow(doc)
    next.boards = boards
    return next
  }

  function addComment(doc, id, by, text) {
    var ts = Date.now()
    return updateBoard(doc, id, function (b) {
      var list = Array.isArray(b.comments) ? b.comments.slice() : []
      list.push({ by: by, ts: ts, text: text })
      b.comments = list
    })
  }

  /* Create a starter board of a given type with a unique id within the doc. */
  function newBoard(doc, type) {
    var id = uniqueId(doc, type)
    var base = { id: id, title: titleCase(type) + ' board', type: type, comments: [] }
    if (type === 'mermaid') base.source = 'flowchart TD\n  A[Start] --> B[End]'
    else if (type === 'table') {
      base.columns = ['col1', 'col2']
      base.rows = [
        ['', ''],
        ['', '']
      ]
    } else if (type === 'chart') {
      base.chart = 'bar'
      base.x = { label: 'x', categories: ['a', 'b'] }
      base.y = { label: 'y' }
      base.series = [{ name: 'series 1', values: [1, 2] }]
    } else if (type === 'note') {
      base.markdown = '# New note\n\nWrite in **markdown**.'
    }
    return base
  }

  function uniqueId(doc, prefix) {
    var n = 1
    var id
    do {
      id = prefix + '-' + n
      n++
    } while (findBoard(doc, id))
    return id
  }

  function titleCase(s) {
    return s.charAt(0).toUpperCase() + s.slice(1)
  }

  /* Reconcile a freshly-arrived remote doc against a local doc that may have an
     open editor. Strategy (spec §5):
       - If the same field of the same board changed both locally and remotely,
         remote wins (caller flashes the cell); otherwise remote is taken wholesale.
     Because context.set is authoritative and the pane always re-reads on a
     `context` event, the simplest correct policy is: remote replaces local, and the
     caller re-applies its open editor's value on top afterwards. We expose a helper
     to detect whether a specific board+field diverged so the caller can flash it. */
  function boardFieldChanged(prevDoc, nextDoc, id, field) {
    var a = findBoard(prevDoc, id)
    var b = findBoard(nextDoc, id)
    if (!a || !b) return a !== b
    return JSON.stringify(a[field]) !== JSON.stringify(b[field])
  }

  /* Serialized-size guard: char budget is maxTokens * 4 (spec §5). */
  function sizeInfo(doc, maxTokens) {
    var chars = serialize(doc).length
    var cap = (maxTokens || 4000) * 4
    return { chars: chars, cap: cap, over: chars > cap, near: chars > cap * 0.8 }
  }

  return {
    BOARD_TYPES: BOARD_TYPES,
    CHART_TYPES: CHART_TYPES,
    parse: parse,
    serialize: serialize,
    findBoard: findBoard,
    boardIndex: boardIndex,
    updateBoard: updateBoard,
    addComment: addComment,
    newBoard: newBoard,
    boardFieldChanged: boardFieldChanged,
    sizeInfo: sizeInfo
  }
})
