// P4 S3 + roadmap Phase 4: runs plugin-contributed tool backends as isolated child processes and
// brokers tool calls, with an optional long-running SERVICE lifecycle. Per CLAUDE.md, backend plugin
// logic NEVER runs in-process (stale-module hazard) — each plugin's backend is one child process. An
// on-demand backend spawns lazily on its first tool call; a service backend spawns when the plugin is
// first enabled in a conversation and lives until it's disabled in the last one. The transport is
// injected so this broker (correlation, timeout, lifecycle, crash budget) is unit-testable without
// Electron; main.ts supplies the real `utilityProcess`-backed transport.

/** A message channel to one backend child process. */
export interface BackendTransport {
  postMessage(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
  onExit(cb: () => void): void
  kill(): void
}

/** Spawns a backend child for a plugin and returns its transport. */
export type SpawnBackend = (backendPath: string, pluginId: string) => BackendTransport

/** Route a service backend's unsolicited publish to the DataBus (main validates the permission). */
export type PublishFromBackend = (
  pluginId: string,
  conversationId: string,
  channel: string,
  data: unknown
) => void

// A child that exits within this window of spawning counts as a crash (vs. a normal later exit).
const CRASH_WINDOW_MS = 5_000
// Consecutive crashes before the plugin's backend is wedged (rejects calls until reloaded).
const CRASH_LIMIT = 3

interface Pending {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
interface Child {
  transport: BackendTransport
  pending: Map<number, Pending>
  spawnedAt: number
}

export class PluginBackendManager {
  private children = new Map<string, Child>()
  // Durable across a child's life (survives restart): which conversations a SERVICE plugin is
  // enabled in. Empty for on-demand plugins.
  private serviceConvs = new Map<string, Set<string>>()
  // Backend path per plugin, remembered so a service can be re-spawned on reload without the caller.
  private backendPaths = new Map<string, string>()
  // Consecutive early-exit count + wedged set (crash budget). Wedged rejects calls until reset().
  private crashCounts = new Map<string, number>()
  private wedged = new Set<string>()
  private seq = 0

  constructor(
    private spawn: SpawnBackend,
    private timeoutMs = 30_000,
    private onPublish?: PublishFromBackend
  ) {}

  /** Call `tool(input)` in the plugin's backend; resolves with the result text the agent receives. */
  invoke(
    pluginId: string,
    backendPath: string,
    tool: string,
    input: unknown,
    timeoutMs?: number
  ): Promise<string> {
    if (this.wedged.has(pluginId)) {
      return Promise.reject(
        new Error(`plugin "${pluginId}" backend crashed repeatedly — fix the plugin and reload it`)
      )
    }
    const child = this.ensure(pluginId, backendPath)
    const id = ++this.seq
    const cap = timeoutMs ?? this.timeoutMs
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.pending.delete(id)
        reject(new Error(`plugin "${pluginId}" tool "${tool}" timed out after ${cap}ms`))
      }, cap)
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

  /** Enable a SERVICE plugin for a conversation: spawn the child on the first enable and tell it. */
  startService(pluginId: string, backendPath: string, conversationId: string): void {
    let convs = this.serviceConvs.get(pluginId)
    if (!convs) {
      convs = new Set()
      this.serviceConvs.set(pluginId, convs)
    }
    convs.add(conversationId)
    this.backendPaths.set(pluginId, backendPath)
    if (this.wedged.has(pluginId)) return // stays down until reload clears the wedge
    const child = this.ensure(pluginId, backendPath)
    this.post(child, { enable: { conversationId } })
  }

  /** Disable a SERVICE plugin for a conversation; kill the child when the last one drops. */
  stopService(pluginId: string, conversationId: string): void {
    const convs = this.serviceConvs.get(pluginId)
    if (!convs) return
    convs.delete(conversationId)
    const child = this.children.get(pluginId)
    if (child) this.post(child, { disable: { conversationId } })
    if (convs.size === 0) {
      this.serviceConvs.delete(pluginId)
      this.stop(pluginId)
    }
  }

  /** Kill a plugin's backend (disable/reload/quit). Pending calls reject; it re-spawns on next use. */
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

  /** Reload (fresh code): kill the child AND clear its crash/wedge state, then re-spawn if it's a
   *  still-enabled service. This is the only path that clears a wedge. */
  reset(pluginId: string): void {
    this.stop(pluginId)
    this.crashCounts.delete(pluginId)
    this.wedged.delete(pluginId)
    const convs = this.serviceConvs.get(pluginId)
    const backendPath = this.backendPaths.get(pluginId)
    if (convs && convs.size > 0 && backendPath) {
      const child = this.ensure(pluginId, backendPath)
      for (const conversationId of convs) this.post(child, { enable: { conversationId } })
    }
  }

  stopAll(): void {
    for (const id of [...this.children.keys()]) this.stop(id)
  }

  private post(child: Child, msg: unknown): void {
    try {
      child.transport.postMessage(msg)
    } catch {
      /* child gone — onExit will clean up */
    }
  }

  private ensure(pluginId: string, backendPath: string): Child {
    const existing = this.children.get(pluginId)
    if (existing) return existing

    this.backendPaths.set(pluginId, backendPath)
    const pending = new Map<number, Pending>()
    const transport = this.spawn(backendPath, pluginId)
    const child: Child = { transport, pending, spawnedAt: Date.now() }

    transport.onMessage((raw) => {
      const m = raw as { id?: unknown; result?: unknown; error?: unknown; publish?: unknown }
      if (m && typeof m === 'object' && m.publish && typeof m.publish === 'object') {
        // Unsolicited push from a service backend. Only allowed to a conversation the plugin is
        // currently enabled in; main additionally checks the data:publish permission.
        const p = m.publish as { conversationId?: unknown; channel?: unknown; data?: unknown }
        const conversationId = typeof p.conversationId === 'string' ? p.conversationId : ''
        const channel = typeof p.channel === 'string' ? p.channel : ''
        if (conversationId && channel && this.serviceConvs.get(pluginId)?.has(conversationId)) {
          this.onPublish?.(pluginId, conversationId, channel, p.data)
        }
        return
      }
      if (!m || typeof m.id !== 'number') return
      const pend = pending.get(m.id)
      if (!pend) return
      pending.delete(m.id)
      clearTimeout(pend.timer)
      if (typeof m.error === 'string' && m.error) pend.reject(new Error(m.error))
      else pend.resolve(typeof m.result === 'string' ? m.result : JSON.stringify(m.result ?? null))
    })

    transport.onExit(() => {
      // The real transport's kill() fires `exit` ASYNCHRONOUSLY, so a stop()/reset() that already
      // removed (and possibly replaced) this child will see its exit arrive late. If we are no
      // longer the current child, this is that stale exit: do nothing — else we'd evict the fresh
      // child from `children` and miscount a deliberate stop as a crash (false wedge).
      if (this.children.get(pluginId) !== child) return
      this.children.delete(pluginId)
      this.failAll(child, `plugin "${pluginId}" backend exited`)
      // Crash budget: an exit within CRASH_WINDOW of spawn is a crash; enough in a row → wedge.
      if (Date.now() - child.spawnedAt <= CRASH_WINDOW_MS) {
        const n = (this.crashCounts.get(pluginId) ?? 0) + 1
        this.crashCounts.set(pluginId, n)
        if (n >= CRASH_LIMIT) this.wedged.add(pluginId)
      } else {
        this.crashCounts.delete(pluginId) // it ran healthily; forget past crashes
      }
    })

    // Tell the backend who it is and whether it's running as a service (so it starts loops only then).
    this.children.set(pluginId, child)
    this.post(child, {
      hello: { pluginId, service: (this.serviceConvs.get(pluginId)?.size ?? 0) > 0 }
    })
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
