// Tracks the background work a conversation has in flight — subagents (Task tool) and background
// tasks — from the SDK's lifecycle hooks (SubagentStart/Stop, TaskCreated/TaskCompleted). Pure and
// synchronous so it is unit-testable without Electron/the SDK; the Session owns one and emits its
// `list()` to the renderer whenever it changes (the top-of-screen "running" indicator + picker).

import type { RunningTask } from '../shared/events.js'

export type { RunningTask }

const keyOf = (kind: RunningTask['kind'], id: string): string => `${kind}:${id}`

export class BackgroundRegistry {
  private tasks = new Map<string, RunningTask>()

  startSubagent(agentId: string, agentType: string, now = Date.now()): void {
    const key = keyOf('subagent', agentId)
    if (this.tasks.has(key)) return
    this.tasks.set(key, {
      id: agentId,
      kind: 'subagent',
      label: agentType || 'subagent',
      startedAt: now
    })
  }

  stopSubagent(agentId: string): void {
    this.tasks.delete(keyOf('subagent', agentId))
  }

  createTask(taskId: string, subject: string, detail?: string, now = Date.now()): void {
    const key = keyOf('task', taskId)
    if (this.tasks.has(key)) return
    this.tasks.set(key, {
      id: taskId,
      kind: 'task',
      label: subject || 'task',
      detail,
      startedAt: now
    })
  }

  completeTask(taskId: string): void {
    this.tasks.delete(keyOf('task', taskId))
  }

  /** Everything currently running, oldest first (stable order for the picker). */
  list(): RunningTask[] {
    return [...this.tasks.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  /** Drop everything (e.g. on rebind — the query that owned these is gone). */
  clear(): void {
    this.tasks.clear()
  }
}
