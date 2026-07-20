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

  // The real utilityProcess transport fires `exit` ASYNCHRONOUSLY after kill(), so a killed child's
  // exit arrives once it has already been replaced/removed. These lock in the identity guard in
  // onExit (without it, a stale exit evicts the fresh child and miscounts deliberate stops as crashes).
  it('ignores a stale child exit that arrives after reset re-spawned (keeps the fresh child)', () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    mgr.startService('p', '/b', 'conv-1') // spawned[0] = current
    mgr.reset('p') // spawned[1] = current; spawned[0] killed
    expect(f.spawned.length).toBe(2)
    f.spawned[0].exit() // old child's late exit (production timing)
    void mgr.invoke('p', '/b', 't', {}) // reuses spawned[1]; would re-spawn if it were evicted
    expect(f.spawned.length).toBe(2)
  })

  it('does not wedge on repeated deliberate stops (their late exits are not crashes)', async () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    for (let i = 0; i < 4; i++) {
      mgr.invoke('p', '/b', 't', {}).catch(() => {}) // spawns child i (current)
      const child = f.last()
      mgr.stop('p') // removes child from the map, then kill()
      child.exit() // production kill() fires this asynchronously — the stale exit
    }
    const p = mgr.invoke('p', '/b', 'echo', {})
    const sent = f.last().posted.find((m) => m.tool === 'echo') as { id: number }
    f.last().emit({ id: sent.id, result: 'ok' })
    await expect(p).resolves.toBe('ok') // not falsely wedged
  })
})

describe('PluginBackendManager — lifecycle context, RPC, and storage (A6/A7/A8)', () => {
  it('A6: includes cwd in hello + enable and conversationId on a tool invoke', () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn, undefined, undefined, (conv) =>
      conv === 'conv-1' ? '/work/one' : null
    )
    mgr.startService('p', '/b', 'conv-1')
    const posted = f.last().posted
    expect((posted.find((m) => m.hello) as { hello: { cwd?: string } }).hello.cwd).toBe('/work/one')
    expect((posted.find((m) => m.enable) as { enable: { cwd?: string } }).enable.cwd).toBe(
      '/work/one'
    )
    void mgr.invoke('p', '/b', 't', { a: 1 }, undefined, 'conv-1')
    const invoke = posted.find((m) => m.tool === 't') as { conversationId?: string }
    expect(invoke.conversationId).toBe('conv-1')
  })

  it('A7: callRpc posts { rpc } and resolves the raw JSON result', async () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    mgr.startService('p', '/b', 'conv-1') // a live service backend is required
    const p = mgr.callRpc('p', 'ping', 'conv-1', { n: 2 })
    const sent = f.last().posted.find((m) => m.rpc) as {
      id: number
      rpc: { conversationId: string; op: string; params: unknown }
    }
    expect(sent.rpc).toEqual({ conversationId: 'conv-1', op: 'ping', params: { n: 2 } })
    f.last().emit({ id: sent.id, result: { pong: 2 } }) // structured, not a string
    await expect(p).resolves.toEqual({ pong: 2 })
  })

  it('A7: callRpc rejects when there is no running service backend', async () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    await expect(mgr.callRpc('p', 'op', 'conv-1', undefined)).rejects.toThrow(/no running service/)
  })

  it('A7: callRpc rejects on the backend error and on timeout', async () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    mgr.startService('p', '/b', 'conv-1')
    const p = mgr.callRpc('p', 'op', 'conv-1', undefined)
    const sent = f.last().posted.find((m) => m.rpc) as { id: number }
    f.last().emit({ id: sent.id, error: 'nope' })
    await expect(p).rejects.toThrow('nope')
  })

  it('A8: brokers a backend storage request and replies { id, result }', async () => {
    const f = backendFactory()
    const calls: unknown[] = []
    const mgr = new PluginBackendManager(
      f.spawn,
      undefined,
      undefined,
      undefined,
      async (pid, req) => {
        calls.push({ pid, req })
        return req.op === 'get' ? 'stored-value' : null
      }
    )
    mgr.startService('p', '/b', 'conv-1')
    f.last().emit({ id: 7, storage: { op: 'get', conversationId: 'conv-1', key: 'k' } })
    await Promise.resolve()
    await Promise.resolve()
    const reply = f.last().posted.find((m) => m.id === 7) as { id: number; result?: unknown }
    expect(reply.result).toBe('stored-value')
    expect(calls[0]).toEqual({ pid: 'p', req: { op: 'get', conversationId: 'conv-1', key: 'k' } })
  })

  it('A8: replies { id, error } when the storage broker rejects (e.g. permission denied)', async () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn, undefined, undefined, undefined, async () => {
      throw new Error('permission "storage" not granted')
    })
    mgr.startService('p', '/b', 'conv-1')
    f.last().emit({ id: 9, storage: { op: 'set', conversationId: 'conv-1', key: 'k', value: 1 } })
    await Promise.resolve()
    await Promise.resolve()
    const reply = f.last().posted.find((m) => m.id === 9) as { id: number; error?: string }
    expect(reply.error).toContain('storage')
  })

  it('A8: refuses cleanly when no storage broker is configured', async () => {
    const f = backendFactory()
    const mgr = new PluginBackendManager(f.spawn)
    mgr.startService('p', '/b', 'conv-1')
    f.last().emit({ id: 3, storage: { op: 'keys', conversationId: 'conv-1' } })
    await Promise.resolve()
    const reply = f.last().posted.find((m) => m.id === 3) as { id: number; error?: string }
    expect(reply.error).toContain('storage not available')
  })
})
