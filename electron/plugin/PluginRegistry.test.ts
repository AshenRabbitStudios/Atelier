import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRegistry } from './PluginRegistry.js'

let root: string

function makePlugin(rel: string, manifest: unknown): void {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  writeFileSync(join(dir, 'manifest.json'), body, 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atelier-plugins-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('PluginRegistry.scan', () => {
  it('discovers a valid top-level plugin', () => {
    makePlugin('hello', {
      id: 'hello',
      name: 'Hello',
      version: '1',
      kind: 'panel',
      entry: 'index.html'
    })
    const reg = new PluginRegistry(root)
    reg.scan()
    const list = reg.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'hello', valid: true })
    expect(reg.dirOf('hello')).toBe(join(root, 'hello'))
  })

  it('discovers plugins nested one level down (examples/)', () => {
    makePlugin('examples/demo', {
      id: 'demo',
      name: 'Demo',
      version: '1',
      kind: 'panel',
      entry: 'index.html'
    })
    const reg = new PluginRegistry(root)
    reg.scan()
    expect(reg.get('demo')?.valid).toBe(true)
  })

  it('marks a broken manifest invalid without throwing', () => {
    makePlugin('broken', '{ not valid json')
    const reg = new PluginRegistry(root)
    reg.scan()
    const p = reg.get('broken')
    expect(p?.valid).toBe(false)
    expect(p?.error).toBeTruthy()
  })

  it('flags an id/folder-name mismatch', () => {
    makePlugin('folder-name', { id: 'other-id', name: 'X', version: '1', kind: 'tool' })
    const reg = new PluginRegistry(root)
    reg.scan()
    expect(reg.get('folder-name')?.valid).toBe(false)
  })

  it('requires entry for a panel plugin', () => {
    makePlugin('nopanel', { id: 'nopanel', name: 'X', version: '1', kind: 'panel' })
    const reg = new PluginRegistry(root)
    reg.scan()
    expect(reg.get('nopanel')?.valid).toBe(false)
  })

  it('returns [] when the root does not exist', () => {
    const reg = new PluginRegistry(join(root, 'does-not-exist'))
    reg.scan()
    expect(reg.list()).toEqual([])
  })
})
