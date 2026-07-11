import { describe, it, expect } from 'vitest'
import { buildEnvironmentBriefing, listPluginsText, describePlugin } from './introspection.js'
import type { PluginRegistry } from './PluginRegistry.js'
import type { ConversationPluginState, DiscoveredPlugin, Manifest } from '../shared/plugins.js'

// A minimal manifest with schema defaults filled in, overridable per test.
function manifest(over: Partial<Manifest> & { id: string }): Manifest {
  return {
    name: over.id,
    version: '1.0.0',
    kind: 'panel',
    permissions: [],
    defaultDock: 'right',
    tools: [],
    contextExports: [],
    ...over
  } as Manifest
}

// Fake registry over the two methods introspection uses: list() (sorted, may include invalids) and
// get(id). Accepts DiscoveredPlugin entries so invalid plugins can be exercised too.
function fakeRegistry(entries: DiscoveredPlugin[]): PluginRegistry {
  const byId = new Map(entries.map((e) => [e.id, e]))
  return {
    list: () => [...entries].sort((a, b) => a.id.localeCompare(b.id)),
    get: (id: string) => byId.get(id)
  } as unknown as PluginRegistry
}

const valid = (m: Manifest): DiscoveredPlugin => ({
  id: m.id,
  dir: `/p/${m.id}`,
  valid: true,
  manifest: m
})
const enabled = (pins: string[] = []): ConversationPluginState => ({
  enabled: true,
  pinnedExports: pins
})

const REG = fakeRegistry([
  valid(manifest({ id: 'cognition', name: 'Cognition', description: 'Persistent working state.' })),
  valid(
    manifest({
      id: 'tool-plugin',
      name: 'Tool Plugin',
      kind: 'both',
      permissions: ['tools'],
      tools: [{ name: 'reverse_text', description: 'Reverse a string.' }]
    })
  ),
  valid(
    manifest({
      id: 'browser',
      name: 'Browser',
      contextExports: [
        {
          key: 'content',
          label: 'Browser content',
          format: 'markdown',
          maxTokens: 8000,
          inject: false,
          description: 'Push HTML.'
        },
        { key: 'page', label: 'Browser page state', format: 'text', maxTokens: 3000, inject: true }
      ]
    })
  ),
  { id: 'broken', dir: '/p/broken', valid: false, error: 'bad manifest' }
])

describe('buildEnvironmentBriefing', () => {
  it('names Atelier, lists every valid plugin, and points at the tools', () => {
    const b = buildEnvironmentBriefing(REG, 'C:\\work\\proj')
    expect(b).toContain('<atelier-environment>')
    expect(b).toContain('inside Atelier')
    expect(b).toContain('C:\\work\\proj')
    expect(b).toContain('- cognition — Persistent working state.')
    expect(b).toContain('- browser —') // no description → falls back to name
    expect(b).toContain('describe_plugin')
    expect(b).not.toContain('broken') // invalid plugins are excluded from the catalog
  })

  it('omits the cwd line when none is given and handles an empty catalog', () => {
    const b = buildEnvironmentBriefing(fakeRegistry([]))
    expect(b).not.toContain('working directory is')
    expect(b).toContain('(none discovered)')
  })
})

describe('listPluginsText', () => {
  it('marks which plugins are enabled for the conversation', () => {
    const text = listPluginsText(REG, { cognition: enabled() })
    expect(text).toContain('- cognition [enabled] —')
    expect(text).toContain('- browser —')
    expect(text).not.toContain('browser [enabled]')
    expect(text).not.toContain('broken')
  })
})

describe('describePlugin', () => {
  it('reports contributed tools and enabled/pinned state', () => {
    const text = describePlugin(REG, { 'tool-plugin': enabled() }, 'tool-plugin')
    expect(text).toContain('Tool Plugin (id: tool-plugin)')
    expect(text).toContain('Status: ENABLED')
    expect(text).toContain('reverse_text — Reverse a string.')
    expect(text).toContain('Permissions: tools.')
  })

  it('lists context documents with push-only flag and pinned state', () => {
    const text = describePlugin(REG, { browser: enabled(['page']) }, 'browser')
    expect(text).toContain('pinned context: page')
    expect(text).toContain(
      '"Browser content" (key: content, markdown) [push-only: not fed back to you] — Push HTML.'
    )
    expect(text).toContain('"Browser page state" (key: page, text)')
  })

  it('reports NOT enabled when the conversation has not enabled it', () => {
    expect(describePlugin(REG, {}, 'cognition')).toContain('Status: NOT enabled')
  })

  it('handles unknown and invalid ids without throwing', () => {
    expect(describePlugin(REG, {}, 'nope')).toContain('No plugin with id "nope"')
    expect(describePlugin(REG, {}, 'broken')).toContain('manifest is invalid: bad manifest')
  })
})
