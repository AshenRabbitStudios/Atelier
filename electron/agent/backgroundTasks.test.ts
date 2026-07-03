import { describe, it, expect } from 'vitest'
import { BackgroundRegistry } from './backgroundTasks.js'

describe('BackgroundRegistry', () => {
  it('tracks subagents and tasks and lists them oldest-first', () => {
    const r = new BackgroundRegistry()
    r.startSubagent('a1', 'code-reviewer', 100)
    r.createTask('t1', 'build the thing', 'a longer description', 200)
    r.startSubagent('a2', 'general-purpose', 300)

    const list = r.list()
    expect(list.map((t) => t.id)).toEqual(['a1', 't1', 'a2'])
    expect(list[0]).toMatchObject({ kind: 'subagent', label: 'code-reviewer' })
    expect(list[1]).toMatchObject({
      kind: 'task',
      label: 'build the thing',
      detail: 'a longer description'
    })
  })

  it('removes a subagent on stop and a task on complete', () => {
    const r = new BackgroundRegistry()
    r.startSubagent('a1', 'x', 1)
    r.createTask('t1', 'y', undefined, 2)
    r.stopSubagent('a1')
    expect(r.list().map((t) => t.id)).toEqual(['t1'])
    r.completeTask('t1')
    expect(r.list()).toEqual([])
  })

  it('is idempotent on duplicate starts and keyed by kind (id can repeat across kinds)', () => {
    const r = new BackgroundRegistry()
    r.startSubagent('x', 'agent', 1)
    r.startSubagent('x', 'agent', 5) // duplicate — ignored, keeps first startedAt
    r.createTask('x', 'task', undefined, 2) // same id, different kind → distinct entry
    const list = r.list()
    expect(list).toHaveLength(2)
    expect(list.find((t) => t.kind === 'subagent')?.startedAt).toBe(1)
  })

  it('clear() empties the registry', () => {
    const r = new BackgroundRegistry()
    r.startSubagent('a', 'b', 1)
    r.clear()
    expect(r.list()).toEqual([])
  })
})
