import { describe, it, expect } from 'vitest'
import { ManifestSchema } from './plugins.js'

describe('ManifestSchema', () => {
  it('accepts a minimal panel manifest and applies defaults', () => {
    const r = ManifestSchema.safeParse({
      id: 'hello-panel',
      name: 'Hello',
      version: '0.1.0',
      entry: 'index.html'
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.kind).toBe('panel')
      expect(r.data.defaultDock).toBe('right')
      expect(r.data.permissions).toEqual([])
      expect(r.data.tools).toEqual([])
      expect(r.data.contextExports).toEqual([])
    }
  })

  it('rejects an invalid id (uppercase/underscore)', () => {
    expect(ManifestSchema.safeParse({ id: 'Hello_Panel', name: 'x', version: '1' }).success).toBe(
      false
    )
  })

  it('rejects a missing name', () => {
    expect(ManifestSchema.safeParse({ id: 'x', version: '1' }).success).toBe(false)
  })

  it('rejects an unknown permission', () => {
    const r = ManifestSchema.safeParse({
      id: 'x',
      name: 'x',
      version: '1',
      permissions: ['fs:write']
    })
    expect(r.success).toBe(false)
  })

  it('accepts the net:fetch permission', () => {
    const r = ManifestSchema.safeParse({
      id: 'x',
      name: 'x',
      version: '1',
      permissions: ['net:fetch']
    })
    expect(r.success).toBe(true)
  })

  it('fills contextExport defaults (format/maxTokens)', () => {
    const r = ManifestSchema.safeParse({
      id: 'x',
      name: 'x',
      version: '1',
      contextExports: [{ key: 'todo', label: 'To-do' }]
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.contextExports[0]).toMatchObject({ format: 'text', maxTokens: 1500 })
    }
  })
})
