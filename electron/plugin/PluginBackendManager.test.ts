import { describe, it, expect, vi } from 'vitest'
import {
  PluginBackendManager,
  type BackendTransport,
  type SpawnBackend
} from './PluginBackendManager.js'

/** An in-memory transport with a scripted responder, so the broker is testable without Electron. */
function fakeBackend(
  respond: (msg: { id: number; tool: string; input: unknown }) => {
    result?: unknown
    error?: string
  } | null
): { transport: BackendTransport; spawn: SpawnBackend; killed: () => number; exit: () => void } {
  let onMsg: ((m: unknown) => void) | null = null
  let onExit: (() => void) | null = null
  let kills = 0
  const transport: BackendTransport = {
    postMessage: (msg) => {
      const m = msg as { id: number; tool: string; input: unknown }
      const r = respond(m)
      if (r && onMsg) onMsg({ id: m.id, ...r })
    },
    onMessage: (cb) => {
      onMsg = cb
    },
    onExit: (cb) => {
      onExit = cb
    },
    kill: () => {
      kills++
    }
  }
  return {
    transport,
    spawn: () => transport,
    killed: () => kills,
    exit: () => onExit?.()
  }
}

describe('PluginBackendManager', () => {
  it('resolves a tool call with the backend result text', async () => {
    const be = fakeBackend((m) => ({ result: `echo:${(m.input as { x: string }).x}` }))
    const mgr = new PluginBackendManager(be.spawn)
    await expect(mgr.invoke('p', '/b', 'echo', { x: 'hi' })).resolves.toBe('echo:hi')
  })

  it('stringifies a non-string result', async () => {
    const be = fakeBackend(() => ({ result: { ok: true } }))
    const mgr = new PluginBackendManager(be.spawn)
    await expect(mgr.invoke('p', '/b', 't', {})).resolves.toBe('{"ok":true}')
  })

  it('rejects when the backend reports an error', async () => {
    const be = fakeBackend(() => ({ error: 'boom' }))
    const mgr = new PluginBackendManager(be.spawn)
    await expect(mgr.invoke('p', '/b', 't', {})).rejects.toThrow('boom')
  })

  it('reuses one child across calls and correlates concurrent responses by id', async () => {
    const spawn = vi.fn(fakeBackend((m) => ({ result: `${m.tool}#${m.id}` })).spawn)
    const mgr = new PluginBackendManager(spawn)
    const [a, b] = await Promise.all([
      mgr.invoke('p', '/b', 'one', {}),
      mgr.invoke('p', '/b', 'two', {})
    ])
    expect(a).toBe('one#1')
    expect(b).toBe('two#2')
    expect(spawn).toHaveBeenCalledTimes(1) // one child reused
  })

  it('times out a backend that never replies', async () => {
    vi.useFakeTimers()
    const be = fakeBackend(() => null) // never responds
    const mgr = new PluginBackendManager(be.spawn, 50)
    const p = mgr.invoke('p', '/b', 't', {})
    const assertion = expect(p).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
    vi.useRealTimers()
  })

  it('stop() kills the child and rejects pending calls', async () => {
    const be = fakeBackend(() => null)
    const mgr = new PluginBackendManager(be.spawn)
    const p = mgr.invoke('p', '/b', 't', {})
    mgr.stop('p')
    await expect(p).rejects.toThrow(/stopped/)
    expect(be.killed()).toBe(1)
  })

  it('rejects pending calls when the child exits on its own', async () => {
    const be = fakeBackend(() => null)
    const mgr = new PluginBackendManager(be.spawn)
    const p = mgr.invoke('p', '/b', 't', {})
    be.exit()
    await expect(p).rejects.toThrow(/exited/)
  })

  it('honours a per-call timeout override', async () => {
    vi.useFakeTimers()
    const be = fakeBackend(() => null)
    const mgr = new PluginBackendManager(be.spawn, 30_000) // default is long
    const p = mgr.invoke('p', '/b', 't', {}, 50) // override short
    const assertion = expect(p).rejects.toThrow(/timed out after 50ms/)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
    vi.useRealTimers()
  })
})

/** A controllable transport: records posted messages and lets a test drive onMessage/onExit. A fresh
 *  child is produced per spawn so crash/restart flows can be exercised independently. */
interface Spawned {
  pluginId: string
  posted: Record<string, unknown>[]
  emit: (m: unknown) => void
  exit: () => void
  kills: () => number
}
function backendFactory(): { spawn: SpawnBackend; spawned: Spawned[]; last: () => Spawned } {
  const spawned: Spawned[] = []
  const spawn: SpawnBackend = (_backendPath, pluginId) => {
    let onMsg: ((m: unknown) => void) | null = null
    let onExit: (() => void) | null = null
    let kills = 0
    const posted: Record<string, unknown>[] = []
    const transport: BackendTransport = {
      postMessage: (msg) => posted.push(msg as Record<string, unknown>),
      onMessage: (cb) => {
        onMsg = cb
      },
      onExit: (cb) => {
        onExit = cb
      },
      kill: () => {
        kills++
      }
    }
    spawned.push({
      pluginId,
      posted,
      emit: (m) => onMsg?.(m),
      exit: () => onExit?.(),
      kills: () => kills
    })
    return transport
  }
  return { spawn, spawned, last: () => spawned[spawned.length - 1] }
}

describe('PluginBackendManager — service lifecycle + crash budget', () => {
  it('posts hello with service:false for an on-demand (invoke) backend', () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    void mgr.invoke('p', '/b', 't', {})
    const hello = f.last().posted.find((m) => m.hello) as { hello: { service: boolean } }
    expect(hello.hello.service).toBe(false)
  })

  it('spawns a service on first enable, reuses it, and posts enable per conversation', () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    mgr.startService('p', '/b', 'conv-1')
    mgr.startService('p', '/b', 'conv-2')
    expect(f.spawned.length).toBe(1) // one child reused
    const posted = f.last().posted
    expect((posted.find((m) => m.hello) as { hello: { service: boolean } }).hello.service).toBe(
      true
    )
    const enables = posted
      .filter((m) => m.enable)
      .map((m) => (m.enable as { conversationId: string }).conversationId)
    expect(enables).toEqual(['conv-1', 'conv-2'])
  })

  it('kills the service only when the last conversation disables it', () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    mgr.startService('p', '/b', 'conv-1')
    mgr.startService('p', '/b', 'conv-2')
    mgr.stopService('p', 'conv-1')
    expect(f.last().kills()).toBe(0) // conv-2 still enabled
    mgr.stopService('p', 'conv-2')
    expect(f.last().kills()).toBe(1)
  })

  it('routes an in-conversation publish and drops one for a conversation it is not enabled in', () => {
    const published: { pid: string; conv: string; ch: string; data: unknown }[] = []
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn, undefined, (pid, conv, ch, data) =>
      published.push({ pid, conv, ch, data })
    )
    mgr.startService('p', '/b', 'conv-1')
    f.last().emit({ publish: { conversationId: 'conv-1', channel: 'x', data: 42 } })
    f.last().emit({ publish: { conversationId: 'nope', channel: 'x', data: 1 } })
    expect(published).toEqual([{ pid: 'p', conv: 'conv-1', ch: 'x', data: 42 }])
  })

  it('wedges a backend after 3 early crashes and clears the wedge on reset', async () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    for (let i = 0; i < 3; i++) {
      const p = mgr.invoke('p', '/b', 't', {}).catch(() => {}) // spawns child i
      f.spawned[i].exit() // immediate exit = a crash
      await p
    }
    await expect(mgr.invoke('p', '/b', 't', {})).rejects.toThrow(/crashed repeatedly/)

    mgr.reset('p') // reload clears the wedge
    const p = mgr.invoke('p', '/b', 'echo', {})
    const sent = f.last().posted.find((m) => m.tool === 'echo') as { id: number }
    f.last().emit({ id: sent.id, result: 'ok' })
    await expect(p).resolves.toBe('ok')
  })

  it('reset re-spawns a still-enabled service and re-sends its enables', () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    mgr.startService('p', '/b', 'conv-1')
    expect(f.spawned.length).toBe(1)
    mgr.reset('p')
    expect(f.spawned.length).toBe(2) // re-spawned
    expect(
      f
        .last()
        .posted.filter((m) => m.enable)
        .map((m) => (m.enable as { conversationId: string }).conversationId)
    ).toEqual(['conv-1'])
  })
})
