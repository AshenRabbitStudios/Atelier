// P4 S3: runs plugin-contributed tool backends as isolated child processes and brokers tool calls.
// Per CLAUDE.md, backend plugin logic NEVER runs in-process (stale-module hazard) — each plugin's
// backend is one child process, spawned lazily on its first tool call and killed on disable/reload.
// The transport is injected so this broker (request/response correlation, timeout, lifecycle) is
// unit-testable without Electron; main.ts supplies the real `utilityProcess`-backed transport.

/** A message channel to one backend child process. */
export interface BackendTransport {
  postMessage(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
  onExit(cb: () => void): void
  kill(): void
}

/** Spawns a backend child for a plugin and returns its transport. */
export type SpawnBackend = (backendPath: string, pluginId: string) => BackendTransport

interface Pending {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
interface Child {
  transport: BackendTransport
  pending: Map<number, Pending>
}

export class PluginBackendManager {
  private children = new Map<string, Child>()
  private seq = 0

  constructor(
    private spawn: SpawnBackend,
    private timeoutMs = 30_000
  ) {}

  /** Call `tool(input)` in the plugin's backend; resolves with the result text the agent receives. */
  invoke(pluginId: string, backendPath: string, tool: string, input: unknown): Promise<string> {
    const child = this.ensure(pluginId, backendPath)
    const id = ++this.seq
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.pending.delete(id)
        reject(new Error(`plugin "${pluginId}" tool "${tool}" timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      child.pending.set(id, { resolve, reject, timer })
      try {
        child.transport.postMessage({ id, tool, input })
      } catch (err) {
        child.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Kill a plugin's backend (disable/reload). Pending calls reject; it re-spawns on next invoke. */
  stop(pluginId: string): void {
    const child = this.children.get(pluginId)
    if (!child) return
    this.children.delete(pluginId)
    this.failAll(child, `plugin "${pluginId}" backend stopped`)
    try {
      child.transport.kill()
    } catch {
      /* already gone */
    }
  }

  stopAll(): void {
    for (const id of [...this.children.keys()]) this.stop(id)
  }

  private ensure(pluginId: string, backendPath: string): Child {
    const existing = this.children.get(pluginId)
    if (existing) return existing

    const pending = new Map<number, Pending>()
    const transport = this.spawn(backendPath, pluginId)
    const child: Child = { transport, pending }

    transport.onMessage((raw) => {
      const m = raw as { id?: unknown; result?: unknown; error?: unknown }
      if (!m || typeof m.id !== 'number') return
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      clearTimeout(p.timer)
      if (typeof m.error === 'string' && m.error) p.reject(new Error(m.error))
      else p.resolve(typeof m.result === 'string' ? m.result : JSON.stringify(m.result ?? null))
    })

    transport.onExit(() => {
      this.children.delete(pluginId)
      this.failAll(child, `plugin "${pluginId}" backend exited`)
    })

    this.children.set(pluginId, child)
    return child
  }

  private failAll(child: Child, reason: string): void {
    for (const p of child.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    child.pending.clear()
  }
}
