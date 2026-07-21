// Whiteboard model tests — the pure sync/merge layer (model.js). The module is a UMD
// script (browser <script> + require()); with the repo set to "type":"module" a plain
// import gets nothing, so evaluate it with a CJS shim.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync(new URL('./model.js', import.meta.url), 'utf8')
const mod = { exports: {} }
new Function('module', src)(mod)
const WB = mod.exports

describe('parse', () => {
  it('empty/null input yields an empty doc, not an error', () => {
    expect(WB.parse(null)).toEqual({ ok: true, doc: { boards: [] } })
    expect(WB.parse('')).toEqual({ ok: true, doc: { boards: [] } })
    expect(WB.parse('   ')).toEqual({ ok: true, doc: { boards: [] } })
  })

  it('malformed JSON is reported with the raw text preserved (never overwritten)', () => {
    const res = WB.parse('{ not json')
    expect(res.ok).toBe(false)
    expect(res.raw).toBe('{ not json')
    expect(res.error).toBeTruthy()
  })

  it('non-object top level is rejected', () => {
    expect(WB.parse('[1,2]').ok).toBe(false)
    expect(WB.parse('42').ok).toBe(false)
  })

  it('accepts an already-parsed object and tolerates missing boards', () => {
    const res = WB.parse({ active: 'a', extra: 1 })
    expect(res.ok).toBe(true)
    expect(res.doc.boards).toEqual([])
    expect(res.doc.extra).toBe(1)
  })

  it('wraps non-object boards instead of dropping them', () => {
    const res = WB.parse({ boards: ['stray'] })
    expect(res.ok).toBe(true)
    expect(res.doc.boards[0].type).toBe('note')
    expect(res.doc.boards[0]._raw).toBe('stray')
  })
})

describe('serialize', () => {
  it('preserves unknown top-level and per-board fields', () => {
    const doc = {
      active: 'b1',
      mystery: { keep: true },
      boards: [{ id: 'b1', type: 'note', markdown: 'x', customField: 7 }]
    }
    const round = JSON.parse(WB.serialize(doc))
    expect(round.mystery).toEqual({ keep: true })
    expect(round.boards[0].customField).toBe(7)
    expect(Object.keys(round)[0]).toBe('active')
  })
})

describe('updateBoard / addComment', () => {
  const doc = { boards: [{ id: 'a', type: 'note', markdown: 'old', keep: 1 }] }

  it('returns a new doc without mutating the original', () => {
    const next = WB.updateBoard(doc, 'a', (b) => {
      b.markdown = 'new'
    })
    expect(doc.boards[0].markdown).toBe('old')
    expect(next.boards[0].markdown).toBe('new')
    expect(next.boards[0].keep).toBe(1)
  })

  it('addComment appends and preserves existing comments', () => {
    const withOne = WB.addComment(doc, 'a', 'user', 'hi')
    const withTwo = WB.addComment(withOne, 'a', 'agent', 'yo')
    expect(withTwo.boards[0].comments.map((c) => c.text)).toEqual(['hi', 'yo'])
    expect(withTwo.boards[0].comments[1].by).toBe('agent')
  })
})

describe('newBoard', () => {
  it('creates unique ids and sane per-type defaults', () => {
    const doc = { boards: [] }
    const chart = WB.newBoard(doc, 'chart')
    expect(chart.chart).toBe('bar')
    expect(chart.series[0].values.length).toBe(chart.x.categories.length)
    const doc2 = { boards: [chart] }
    const chart2 = WB.newBoard(doc2, 'chart')
    expect(chart2.id).not.toBe(chart.id)
    expect(WB.newBoard(doc, 'table').columns.length).toBeGreaterThan(0)
    expect(WB.newBoard(doc, 'mermaid').source).toContain('flowchart')
  })

  it('CHART_TYPES includes waterfall', () => {
    expect(WB.CHART_TYPES).toContain('waterfall')
  })
})

describe('table row/col deletion with style remapping', () => {
  const board = () => ({
    id: 't',
    type: 'table',
    columns: ['a', 'b', 'c'],
    rows: [
      ['r0a', 'r0b', 'r0c'],
      ['r1a', 'r1b', 'r1c'],
      ['r2a', 'r2b', 'r2c']
    ],
    align: ['left', 'right', 'center'],
    styles: {
      '0,0': { bg: '#111' },
      '1,1': { bold: true },
      '2,2': { color: '#f00' },
      weird: { keep: true }
    }
  })

  it('deleteTableRow removes the row and shifts style keys below it', () => {
    const b = board()
    WB.deleteTableRow(b, 1)
    expect(b.rows.length).toBe(2)
    expect(b.rows[1][0]).toBe('r2a')
    expect(b.styles['0,0']).toEqual({ bg: '#111' })
    expect(b.styles['1,1']).toBeUndefined() // deleted row's style gone
    expect(b.styles['1,2']).toEqual({ color: '#f00' }) // shifted up
    expect(b.styles.weird).toEqual({ keep: true }) // unknown key preserved
  })

  it('deleteTableCol removes the column from rows, align, and styles', () => {
    const b = board()
    WB.deleteTableCol(b, 1)
    expect(b.columns).toEqual(['a', 'c'])
    expect(b.rows[0]).toEqual(['r0a', 'r0c'])
    expect(b.align).toEqual(['left', 'center'])
    expect(b.styles['0,0']).toEqual({ bg: '#111' })
    expect(b.styles['2,1']).toEqual({ color: '#f00' }) // col 2 → col 1
  })

  it('drops the styles map entirely when it empties', () => {
    const b = { rows: [['x']], columns: ['a'], styles: { '0,0': { bold: true } } }
    WB.deleteTableRow(b, 0)
    expect(b.styles).toBeUndefined()
  })
})

describe('sizeInfo', () => {
  it('flags docs near and over the char budget', () => {
    const small = WB.sizeInfo({ boards: [] }, 4000)
    expect(small.over).toBe(false)
    const big = {
      boards: [{ id: 'n', type: 'note', markdown: 'x'.repeat(20000) }]
    }
    expect(WB.sizeInfo(big, 4000).over).toBe(true)
  })
})
