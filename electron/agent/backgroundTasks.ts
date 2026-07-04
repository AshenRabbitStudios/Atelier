// Tracks the background work a conversation has in flight — subagents (Task tool calls, keyed by
// the call's toolUseId, detected from their forwarded messages in the pump) and background tasks
// (TaskCreated/TaskCompleted hooks). Pure and synchronous so it is unit-testable without
// Electron/the SDK; the Session owns one and emits its `list()` to the renderer whenever it
// changes (the running indicator + picker). Mutators report whether they changed anything so the
// caller can emit only on a real change.

import type { RunningTask } from '../shared/events.js'

export type { RunningTask }

const keyOf = (kind: RunningTask['kind'], id: string): string => `${kind}:${id}`

export class BackgroundRegistry {
  private tasks = new Map<string, RunningTask>()

  /** @returns true if this is a new subagent (false = already tracked). */
  startSubagent(id: string, label: string, detail?: string, now = Date.now()): boolean {
    const key = keyOf('subagent', id)
    if (this.tasks.has(key)) return false
    this.tasks.set(key, {
      id,
      kind: 'subagent',
      label: label || 'subagent',
      detail,
      startedAt: now
    })
    return true
  }

  /** @returns true if the subagent was tracked (false = unknown id, nothing changed). */
  stopSubagent(id: string): boolean {
    return this.tasks.delete(keyOf('subagent', id))
  }

  /** @returns true if this is a new task. */
  createTask(taskId: string, subject: string, detail?: string, now = Date.now()): boolean {
    const key = keyOf('task', taskId)
    if (this.tasks.has(key)) return false
    this.tasks.set(key, {
      id: taskId,
      kind: 'task',
      label: subject || 'task',
      detail,
      startedAt: now
    })
    return true
  }

  /** @returns true if the task was tracked. */
  completeTask(taskId: string): boolean {
    return this.tasks.delete(keyOf('task', taskId))
  }

  /** Drop all subagent entries (tasks kept). Used to clear stale subagents the Task tool_result
   *  never closed (run_in_background acks, interrupted turns), reconciled against SDK ground truth.
   *  @returns true if anything was removed. */
  clearSubagents(): boolean {
    let changed = false
    for (const [key, task] of this.tasks) {
      if (task.kind === 'subagent') {
        this.tasks.delete(key)
        changed = true
      }
    }
    return changed
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
