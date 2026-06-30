import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { z } from 'zod'
import { jsonSchemaToZodShape, buildPluginTools, buildPluginToolServers } from './pluginTools.js'
import type { PluginRegistry } from './PluginRegistry.js'
import type { Manifest } from '../shared/plugins.js'

describe('jsonSchemaToZodShape', () => {
  it('maps type descriptors to zod, honoring the optional `?` suffix', () => {
    const shape = jsonSchemaToZodShape({ a: 'string', b: 'number?', c: 'boolean' })
    expect(shape.a).toBeInstanceOf(z.ZodString)
    expect(shape.b).toBeInstanceOf(z.ZodOptional)
    expect(shape.c).toBeInstanceOf(z.ZodBoolean)
    // The optional field accepts undefined; the required one rejects it.
    expect(shape.b.safeParse(undefined).success).toBe(true)
    expect(shape.a.safeParse(undefined).success).toBe(false)
  })

  it('falls back to unknown for unrecognized types and handles an empty descriptor', () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({})
    const shape = jsonSchemaToZodShape({ x: 'weird' })
    expect(shape.x.safeParse({ anything: true }).success).toBe(true)
  })
})

// A minimal fake registry returning the manifests/dirs we feed it.
function fakeRegistry(
  entries: Record<string, { manifest: Manifest; dir: string }>
): PluginRegistry {
  return {
    get: (id: string) => (entries[id] ? { id, valid: true, ...entries[id] } : undefined),
    dirOf: (id: string) => entries[id]?.dir ?? null
  } as unknown as PluginRegistry
}

const toolManifest = (over: Partial<Manifest> = {}): Manifest =>
  ({
    id: 'demo',
    name: 'Demo',
    version: '0.1.0',
    kind: 'both',
    entry: 'index.html',
    backend: 'backend.cjs',
    permissions: ['tools'],
    defaultDock: 'right',
    tools: [{ name: 'reverse_text', description: 'reverse', inputSchema: { text: 'string' } }],
    contextExports: [],
    ...over
  }) as Manifest

describe('buildPluginTools / buildPluginToolServers', () => {
  it('exposes an enabled tool-plugin’s tool whose handler forwards to its backend', async () => {
    const registry = fakeRegistry({ demo: { manifest: toolManifest(), dir: '/plugins/demo' } })
    const invoke = vi.fn().mockResolvedValue('cba')
    const tools = buildPluginTools(registry, { demo: { enabled: true, pinnedExports: [] } }, invoke)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('reverse_text')

    const out = await tools[0].handler({ text: 'abc' }, undefined)
    expect(invoke).toHaveBeenCalledWith(
      'demo',
      join('/plugins/demo', 'backend.cjs'),
      'reverse_text',
      { text: 'abc' }
    )
    expect(out.content[0]).toEqual({ type: 'text', text: 'cba' })

    // The server wrapper exposes them under the atelier_plugins key.
    const servers = buildPluginToolServers(
      registry,
      { demo: { enabled: true, pinnedExports: [] } },
      invoke
    )
    expect(servers && 'atelier_plugins' in servers).toBe(true)
  })

  it('skips plugins that are disabled, lack the tools permission, or have no backend', () => {
    const registry = fakeRegistry({
      off: { manifest: toolManifest(), dir: '/p/off' },
      noperm: { manifest: toolManifest({ permissions: [] }), dir: '/p/noperm' },
      noback: { manifest: toolManifest({ backend: undefined }), dir: '/p/noback' }
    })
    expect(
      buildPluginToolServers(
        registry,
        {
          off: { enabled: false, pinnedExports: [] },
          noperm: { enabled: true, pinnedExports: [] },
          noback: { enabled: true, pinnedExports: [] }
        },
        vi.fn()
      )
    ).toBeUndefined()
  })
})
