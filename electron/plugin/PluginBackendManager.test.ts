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
})
