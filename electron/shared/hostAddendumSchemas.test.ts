import { describe, it, expect } from 'vitest'
import {
  PluginFsListSchema,
  PluginShellOpenSchema,
  PluginNotifySchema,
  PluginHistorySchema,
  PluginBackendCallSchema
} from './events.js'
import { PLUGIN_PERMISSIONS, ManifestSchema } from './plugins.js'

// The new host-API payloads are Zod-validated at the receiving side (main). These lock in the shape
// so a drift between the preload bridge and the handler surfaces at build/test time (HOST-ADDENDUM
// "every new IPC payload Zod-validated main-side").

describe('host-addendum payload schemas', () => {
  it('PluginFsListSchema: dir is optional', () => {
    expect(PluginFsListSchema.parse({ conversationId: 'c', pluginId: 'p' }).dir).toBeUndefined()
    expect(PluginFsListSchema.parse({ conversationId: 'c', pluginId: 'p', dir: 'sub' }).dir).toBe(
      'sub'
    )
    expect(() => PluginFsListSchema.parse({ pluginId: 'p' })).toThrow()
  })

  it('PluginShellOpenSchema: path required and non-empty', () => {
    expect(() =>
      PluginShellOpenSchema.parse({ conversationId: 'c', pluginId: 'p', path: '' })
    ).toThrow()
    expect(
      PluginShellOpenSchema.parse({ conversationId: 'c', pluginId: 'p', path: 'a.txt' }).path
    ).toBe('a.txt')
  })

  it('PluginNotifySchema: title required, body defaults present, sound/tag optional', () => {
    const n = PluginNotifySchema.parse({ conversationId: 'c', pluginId: 'p', title: 'T', body: '' })
    expect(n.title).toBe('T')
    expect(n.sound).toBeUndefined()
    expect(() =>
      PluginNotifySchema.parse({ conversationId: 'c', pluginId: 'p', body: 'x' })
    ).toThrow()
  })

  it('PluginHistorySchema: limit bounded to 1000', () => {
    expect(
      PluginHistorySchema.parse({ conversationId: 'c', pluginId: 'p', limit: 500 }).limit
    ).toBe(500)
    expect(() =>
      PluginHistorySchema.parse({ conversationId: 'c', pluginId: 'p', limit: 1001 })
    ).toThrow()
  })

  it('PluginBackendCallSchema: op required, timeoutMs bounded to 600000', () => {
    expect(
      PluginBackendCallSchema.parse({ conversationId: 'c', pluginId: 'p', op: 'ping' }).op
    ).toBe('ping')
    expect(() =>
      PluginBackendCallSchema.parse({
        conversationId: 'c',
        pluginId: 'p',
        op: 'x',
        timeoutMs: 700000
      })
    ).toThrow()
  })

  it('the new permissions are in the manifest enum and validate on a manifest', () => {
    for (const perm of ['fs:list', 'shell:open', 'agent:compose', 'os:notify']) {
      expect(PLUGIN_PERMISSIONS).toContain(perm)
    }
    const m = ManifestSchema.parse({
      id: 'p',
      name: 'P',
      version: '1',
      permissions: ['fs:list', 'shell:open', 'agent:compose', 'os:notify']
    })
    expect(m.permissions).toEqual(['fs:list', 'shell:open', 'agent:compose', 'os:notify'])
  })
})
