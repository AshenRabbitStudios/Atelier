import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  WorkspaceRegistries,
  type WorkspaceRegistry,
  type MakeRegistry,
  type WorkspaceChange
} from './WorkspaceRegistries.js'
import { mergeRegistry } from './registryView.js'
import {
  encodePluginHost,
  decodePluginHost,
  type DiscoveredPlugin,
  type RegistryView
} from '../shared/plugins.js'

const valid = (id: string, dir = `/w/${id}`): DiscoveredPlugin => ({ id, dir, valid: true })
const invalid = (id: string, error = 'bad'): DiscoveredPlugin => ({
  id,
  dir: `/w/${id}`,
  valid: false,
  error
})

class FakeReg implements WorkspaceRegistry {
  plugins: DiscoveredPlugin[] = []
  started = false
  stopped = false
  constructor(private onChange: () => void) {}
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  list(): DiscoveredPlugin[] {
    return this.plugins
  }
  get(id: string): DiscoveredPlugin | undefined {
    return this.plugins.find((p) => p.id === id)
  }
  dirOf(id: string): string | null {
    return this.plugins.find((p) => p.id === id)?.dir ?? null
  }
  /** Simulate a filesystem rescan discovering a new plugin set. */
  rescan(plugins: DiscoveredPlugin[]): void {
    this.plugins = plugins
    this.onChange()
  }
}

function factory(): { make: MakeRegistry; created: { root: string; reg: FakeReg }[] } {
  const created: { root: string; reg: FakeReg }[] = []
  const make: MakeRegistry = (root, onChange) => {
    const reg = new FakeReg(onChange)
    created.push({ root, reg })
    return reg
  }
  return { make, created }
}

// Identity-ish hash so the key index is deterministic and readable in assertions.
const idHash = (cwd: string): string => 'H' + cwd

describe('encodePluginHost / decodePluginHost', () => {
  it('round-trips a global id (no workspace)', () => {
    expect(encodePluginHost('my-plugin')).toBe('my-plugin')
    expect(decodePluginHost('my-plugin')).toEqual({ pluginId: 'my-plugin' })
  })

  it('round-trips a workspace host, even when the id contains --', () => {
    const host = encodePluginHost('a--weird--id', 'a1b2c3d4e5f6')
    expect(host).toBe('w--a1b2c3d4e5f6--a--weird--id')
    expect(decodePluginHost(host)).toEqual({
      pluginId: 'a--weird--id',
      workspaceKey: 'a1b2c3d4e5f6'
    })
  })

  it('treats a non-matching w-- host as a plain id (needs the fixed-length hex key)', () => {
    expect(decodePluginHost('w--short--id')).toEqual({ pluginId: 'w--short--id' })
  })
})

describe('mergeRegistry', () => {
  const global: RegistryView = {
    get: (id) => (id === 'g' ? valid('g', '/g/g') : undefined),
    dirOf: (id) => (id === 'g' ? '/g/g' : null),
    list: () => [valid('g', '/g/g')]
  }
  const workspace: RegistryView = {
    get: (id) => [valid('w'), valid('g', '/w/g')].find((p) => p.id === id),
    dirOf: (id) => (id === 'w' ? '/w/w' : id === 'g' ? '/w/g' : null),
    list: () => [valid('w'), valid('g', '/w/g')]
  }

  it('global wins id collisions; workspace-only ids are tagged with scope + key', () => {
    const m = mergeRegistry(global, workspace, 'KEY')
    expect(m.get('g')).toMatchObject({ scope: 'global', dir: '/g/g' })
    expect(m.get('w')).toMatchObject({ scope: 'workspace', workspaceKey: 'KEY', dir: '/w/w' })
    expect(m.dirOf('g')).toBe('/g/g') // global dir, not the shadowed workspace one
    expect(m.dirOf('w')).toBe('/w/w')
  })

  it('lists globals + workspace, shadowing a colliding workspace id as invalid', () => {
    const list = mergeRegistry(global, workspace, 'KEY').list()
    const g = list.find((p) => p.id === 'g' && p.scope === 'global')
    const wShadow = list.find((p) => p.id === 'g' && p.scope === 'workspace')
    const w = list.find((p) => p.id === 'w')
    expect(g?.valid).toBe(true)
    expect(wShadow).toMatchObject({ valid: false, error: 'id shadowed by a global plugin' })
    expect(w).toMatchObject({ valid: true, scope: 'workspace', workspaceKey: 'KEY' })
  })

  it('works with no workspace registry (pure global, tagged global)', () => {
    const list = mergeRegistry(global).list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'g', scope: 'global' })
  })
})

describe('WorkspaceRegistries lifecycle', () => {
  it('creates one started registry per cwd, shared across conversations on it', () => {
    const f = factory()
    const wr = new WorkspaceRegistries(f.make, () => {}, idHash)
    wr.acquire('c1', '/repo')
    wr.acquire('c2', '/repo') // same cwd → reuse
    expect(f.created).toHaveLength(1)
    expect(f.created[0].root).toBe(join('/repo', '.atelier', 'plugins'))
    expect(f.created[0].reg.started).toBe(true)
    expect(wr.keyForCwd('/repo')).toBe('H/repo')
    expect(wr.registryForKey('H/repo')).toBe(f.created[0].reg)
  })

  it('stops the registry only when the last conversation on the cwd is released', () => {
    const f = factory()
    const wr = new WorkspaceRegistries(f.make, () => {}, idHash)
    wr.acquire('c1', '/repo')
    wr.acquire('c2', '/repo')
    wr.release('c1')
    expect(f.created[0].reg.stopped).toBe(false)
    wr.release('c2')
    expect(f.created[0].reg.stopped).toBe(true)
    expect(wr.registryForCwd('/repo')).toBeUndefined()
    expect(wr.registryForKey('H/repo')).toBeUndefined()
  })

  it('reconcile acquires new and releases gone conversations', () => {
    const f = factory()
    const wr = new WorkspaceRegistries(f.make, () => {}, idHash)
    wr.reconcile([
      { id: 'c1', cwd: '/a' },
      { id: 'c2', cwd: '/b' }
    ])
    expect(f.created).toHaveLength(2)
    wr.reconcile([{ id: 'c2', cwd: '/b' }]) // c1 gone
    expect(wr.registryForCwd('/a')).toBeUndefined()
    expect(wr.registryForCwd('/b')).toBeDefined()
  })

  it('emits an added/removed valid-id diff (with the cwd conversations) on rescan', () => {
    const changes: WorkspaceChange[] = []
    const f = factory()
    const wr = new WorkspaceRegistries(f.make, (c) => changes.push(c), idHash)
    wr.acquire('c1', '/repo')
    wr.acquire('c2', '/repo')
    const reg = f.created[0].reg
    reg.rescan([valid('demo'), invalid('broken')]) // demo added; broken is not valid → not counted
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ cwd: '/repo', added: ['demo'], removed: [] })
    expect(changes[0].convs.sort()).toEqual(['c1', 'c2'])
    reg.rescan([]) // demo removed
    expect(changes[1]).toMatchObject({ added: [], removed: ['demo'] })
  })
})
