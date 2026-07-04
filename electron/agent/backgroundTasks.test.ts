import { describe, it, expect } from 'vitest'
import { BackgroundRegistry } from './backgroundTasks.js'

describe('BackgroundRegistry', () => {
  it('tracks subagents and tasks and lists them oldest-first', () => {
    const r = new BackgroundRegistry()
    r.startSubagent('a1', 'code-reviewer', undefined, 100)
    r.createTask('t1', 'build the thing', 'a longer description', 200)
    r.startSubagent('a2', 'general-purpose', undefined, 300)

    const list = r.list()
    expect(list.map((t) => t.id)).toEqual(['a1', 't1', 'a2'])
    expect(list[0]).toMatchObject({ kind: 'subagent', label: 'code-reviewer' })
    expect(list[1]).toMatchObject({
      kind: 'task',
      label: 'build the thing',
      detail: 'a longer description'
    })
  })

  it('removes a subagent on stop and a task on complete (reporting the change)', () => {
    const r = new BackgroundRegistry()
    r.startSubagent('a1', 'x', undefined, 1)
    r.createTask('t1', 'y', undefined, 2)
    expect(r.stopSubagent('a1')).toBe(true)
    expect(r.stopSubagent('a1')).toBe(false) // already gone — no change to emit
    expect(r.list().map((t) => t.id)).toEqual(['t1'])
    r.completeTask('t1')
    expect(r.list()).toEqual([])
  })

  it('is idempotent on duplicate starts and keyed by kind (id can repeat across kinds)', () => {
    const r = new BackgroundRegistry()
    expect(r.startSubagent('x', 'agent', undefined, 1)).toBe(true) // new — caller emits
    expect(r.startSubagent('x', 'agent', undefined, 5)).toBe(false) // duplicate — keeps first
    r.createTask('x', 'task', undefined, 2) // same id, different kind → distinct entry
    const list = r.list()
    expect(list).toHaveLength(2)
    expect(list.find((t) => t.kind === 'subagent')?.startedAt).toBe(1)
  })

  it('clear() empties the registry', () => {
    const r = new BackgroundRegistry()
    r.startSubagent('a', 'b', undefined, 1)
    r.clear()
    expect(r.list()).toEqual([])
  })
})
