import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.ATELIER_TEST_USERDATA as string }
}))

import {
  buildContextBlock,
  buildContextMcpServers,
  buildSystemInstruction,
  contextStorageKey,
  estimateTranscriptTokens,
  guideStorageKey,
  pluginContextContributions,
  pluginValueOrDefault
} from './contextTools.js'
import type { TranscriptMessage } from '../shared/events.js'
import { pluginStorageSet } from './pluginStorage.js'
import type { PluginRegistry } from './PluginRegistry.js'
import type { ConversationPluginState } from '../shared/plugins.js'

let userData: string

type Exports = {
  key: string
  label: string
  format: string
  maxTokens: number
  inject?: boolean
  readonly?: boolean
}[]
function fakeRegistry(byId: Record<string, Exports>): PluginRegistry {
  return {
    get: (id: string) => (byId[id] ? { manifest: { contextExports: byId[id] } } : undefined)
  } as unknown as PluginRegistry
}
const pinned = (keys: string[]): ConversationPluginState => ({ enabled: true, pinnedExports: keys })

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'atelier-ctx-'))
  process.env.ATELIER_TEST_USERDATA = userData
})
afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
  delete process.env.ATELIER_TEST_USERDATA
})

const REG = fakeRegistry({
  mm: [{ key: 'model', label: 'Mental model', format: 'markdown', maxTokens: 1000 }]
})

describe('buildContextBlock', () => {
  it('is empty when nothing is pinned', () => {
    expect(buildContextBlock(REG, 'c1', {})).toBe('')
  })

  it('includes a pinned, enabled, non-empty export', () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'A house has 3 rooms')
    const block = buildContextBlock(REG, 'c1', { mm: pinned(['model']) })
    expect(block).toContain('<atelier-context>')
    expect(block).toContain('## Mental model')
    expect(block).toContain('A house has 3 rooms')
  })

  it('skips disabled, unpinned, and empty exports', () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'X')
    expect(buildContextBlock(REG, 'c1', { mm: { enabled: false, pinnedExports: ['model'] } })).toBe(
      ''
    )
    expect(buildContextBlock(REG, 'c1', { mm: pinned([]) })).toBe('')
    expect(buildContextBlock(REG, 'c2', { mm: pinned(['model']) })).toBe('') // other conversation
  })

  it('truncates a value beyond maxTokens', () => {
    pluginStorageSet('c1', 'big', contextStorageKey('model'), 'x'.repeat(100))
    const reg = fakeRegistry({
      big: [{ key: 'model', label: 'M', format: 'text', maxTokens: 10 }] // cap ~40 chars
    })
    expect(buildContextBlock(reg, 'c1', { big: pinned(['model']) })).toContain('…[truncated]')
  })

  it('injects the author guide alongside the value, framed read-only', () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'A house has 3 rooms')
    pluginStorageSet('c1', 'mm', guideStorageKey('model'), 'Keep this under 5 bullet points.')
    const block = buildContextBlock(REG, 'c1', { mm: pinned(['model']) })
    expect(block).toContain('Keep this under 5 bullet points.')
    expect(block).toContain('do not edit')
    expect(block).toContain('A house has 3 rooms')
  })

  it('injects a guide even when the value is empty', () => {
    pluginStorageSet('c1', 'mm', guideStorageKey('model'), 'Author note with no doc yet.')
    const block = buildContextBlock(REG, 'c1', { mm: pinned(['model']) })
    expect(block).toContain('Author note with no doc yet.')
  })

  const NS_REG = fakeRegistry({
    ns: [{ key: 'star', label: 'North Star', format: 'markdown', maxTokens: 500, readonly: true }]
  })

  it('injects a read-only export with user-authored framing and its guide', () => {
    pluginStorageSet('c1', 'ns', contextStorageKey('star'), 'Ship the thing')
    pluginStorageSet('c1', 'ns', guideStorageKey('star'), 'Prefer this over local tasks.')
    const block = buildContextBlock(NS_REG, 'c1', { ns: pinned(['star']) })
    expect(block).toContain('## North Star')
    expect(block).toContain('read-only to you')
    expect(block).toContain('Ship the thing')
    expect(block).toContain('Prefer this over local tasks.')
    // Never framed as a maintain-it-yourself section.
    expect(block).not.toContain('do not edit')
  })

  it('skips a read-only export with no value, even when a guide default exists', () => {
    pluginStorageSet('c1', 'ns', guideStorageKey('star'), 'Orient toward the star.')
    expect(buildContextBlock(NS_REG, 'c1', { ns: pinned(['star']) })).toBe('')
  })
})

describe('buildContextMcpServers', () => {
  it('is undefined when nothing is pinned', () => {
    expect(buildContextMcpServers(REG, 'c1', {}, () => {})).toBeUndefined()
  })

  it('builds an sdk server when an export is pinned', () => {
    const servers = buildContextMcpServers(REG, 'c1', { mm: pinned(['model']) }, () => {})
    expect(servers?.atelier_context).toBeDefined()
    expect(servers?.atelier_context.type).toBe('sdk')
  })

  it('registers NO write-tool for a read-only export', () => {
    const reg = fakeRegistry({
      ns: [{ key: 'star', label: 'North Star', format: 'markdown', maxTokens: 500, readonly: true }]
    })
    // A read-only export is the only thing pinned → no tools → server is undefined.
    expect(buildContextMcpServers(reg, 'c1', { ns: pinned(['star']) }, () => {})).toBeUndefined()
  })

  it('the set_ tool persists the value and fires onChange (the push trigger)', async () => {
    const changes: { pluginId: string; key: string }[] = []
    const servers = buildContextMcpServers(REG, 'c1', { mm: pinned(['model']) }, (pluginId, key) =>
      changes.push({ pluginId, key })
    )
    // Invoke the registered tool's callback the way the agent would (reaches into the MCP
    // SDK's McpServer internals — brittle by design, so an SDK upgrade fails loudly here).
    const reg = (servers!.atelier_context.instance as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { handler: (a: { content: string }) => Promise<unknown> }>
    const entry = reg['set_mm__model']
    expect(entry).toBeDefined()
    await entry.handler({ content: 'new model text' })
    // Value landed in storage …
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe('new model text')
    // … and onChange fired with the routing keys main.ts forwards as context:changed.
    expect(changes).toEqual([{ pluginId: 'mm', key: 'model' }])
  })
})

describe('the edit_ tool (targeted find-and-replace)', () => {
  type EditArgs = { old_string: string; new_string: string; replace_all?: boolean }
  type EditResult = { content: { text: string }[]; isError?: boolean }
  type ToolEntry = { handler: (a: EditArgs) => Promise<EditResult> }

  function editTool(conversationId: string, onChange: (p: string, k: string) => void = () => {}) {
    const servers = buildContextMcpServers(REG, conversationId, { mm: pinned(['model']) }, onChange)
    const reg = (servers!.atelier_context.instance as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, ToolEntry>
    return reg['edit_mm__model']
  }

  it('is registered alongside set_ for every pinned export', () => {
    const servers = buildContextMcpServers(REG, 'c1', { mm: pinned(['model']) }, () => {})
    const reg = (servers!.atelier_context.instance as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, unknown>
    expect(reg['set_mm__model']).toBeDefined()
    expect(reg['edit_mm__model']).toBeDefined()
  })

  it('replaces a unique occurrence, persists, and fires onChange', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'A house has 3 rooms and 1 door')
    const changes: { pluginId: string; key: string }[] = []
    const t = editTool('c1', (pluginId, key) => changes.push({ pluginId, key }))
    const res = await t.handler({ old_string: '3 rooms', new_string: '4 rooms' })
    expect(res.isError).toBeFalsy()
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe(
      'A house has 4 rooms and 1 door'
    )
    expect(changes).toEqual([{ pluginId: 'mm', key: 'model' }])
  })

  it('errors (without writing) when old_string is not unique and replace_all is unset', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'red red red')
    const changes: unknown[] = []
    const t = editTool('c1', () => changes.push(1))
    const res = await t.handler({ old_string: 'red', new_string: 'blue' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('not unique')
    // storage untouched, no push fired
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe('red red red')
    expect(changes).toEqual([])
  })

  it('replaces every occurrence with replace_all', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'red red red')
    const res = await editTool('c1').handler({
      old_string: 'red',
      new_string: 'blue',
      replace_all: true
    })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('3 replacements')
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe('blue blue blue')
  })

  it('errors when old_string is not found', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'the map is not the territory')
    const res = await editTool('c1').handler({ old_string: 'nowhere', new_string: 'x' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('not found')
  })

  it('errors on an empty value and points at set_', async () => {
    const res = await editTool('c1').handler({ old_string: 'a', new_string: 'b' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('set_mm__model')
  })

  it('treats `$` in new_string literally (no String.replace pattern interpretation)', async () => {
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'cost is TOKEN here')
    const res = await editTool('c1').handler({ old_string: 'TOKEN', new_string: '$1 & $&' })
    expect(res.isError).toBeFalsy()
    expect(pluginValueOrDefault(REG, 'c1', 'mm', contextStorageKey('model'))).toBe(
      'cost is $1 & $& here'
    )
  })
})

describe('push-only exports (inject:false)', () => {
  const PUSH = fakeRegistry({
    viz: [
      { key: 'architecture', label: 'Architecture', format: 'json', maxTokens: 8000, inject: false }
    ]
  })
  it('registers the write-tool but never injects the value', () => {
    pluginStorageSet('c1', 'viz', contextStorageKey('architecture'), '{"nodes":[]}')
    // value is NOT fed back into the per-turn context block …
    expect(buildContextBlock(PUSH, 'c1', { viz: pinned(['architecture']) })).toBe('')
    // … but the agent still gets its set_ write-tool
    const servers = buildContextMcpServers(PUSH, 'c1', { viz: pinned(['architecture']) }, () => {})
    expect(servers?.atelier_context).toBeDefined()
  })
})

describe('buildSystemInstruction', () => {
  // A registry whose `instr` plugin declares a systemInstruction sourced from ctx:instruction.
  const SI = {
    get: (id: string) =>
      id === 'instr'
        ? { manifest: { systemInstruction: { key: 'instruction', maxTokens: 1000 } } }
        : undefined
  } as unknown as PluginRegistry
  const on = (): ConversationPluginState => ({ enabled: true, pinnedExports: [] })

  it('is empty when no enabled plugin contributes one', () => {
    expect(buildSystemInstruction(SI, 'c1', {})).toBe('')
  })

  it('returns the stored instruction for an enabled plugin', () => {
    pluginStorageSet('c1', 'instr', contextStorageKey('instruction'), 'This project is Go.')
    expect(buildSystemInstruction(SI, 'c1', { instr: on() })).toBe('This project is Go.')
  })

  it('skips disabled plugins, empty values, and other conversations', () => {
    pluginStorageSet('c1', 'instr', contextStorageKey('instruction'), 'X')
    expect(buildSystemInstruction(SI, 'c1', { instr: { enabled: false, pinnedExports: [] } })).toBe(
      ''
    )
    pluginStorageSet('c2', 'instr', contextStorageKey('instruction'), '   ')
    expect(buildSystemInstruction(SI, 'c2', { instr: on() })).toBe('')
    expect(buildSystemInstruction(SI, 'c3', { instr: on() })).toBe('') // no value for c3
  })

  it('truncates past the cap', () => {
    const big = {
      get: () => ({ manifest: { systemInstruction: { key: 'instruction', maxTokens: 10 } } }) // ~40 chars
    } as unknown as PluginRegistry
    pluginStorageSet('c1', 'instr', contextStorageKey('instruction'), 'x'.repeat(200))
    expect(buildSystemInstruction(big, 'c1', { instr: on() })).toContain('…[truncated]')
  })
})

describe('pluginContextContributions', () => {
  it('is empty when nothing is pinned or enabled', () => {
    expect(pluginContextContributions(REG, 'c1', {})).toEqual([])
  })

  it('estimates a pinned export at ~chars/4, labelled by the plugin name', () => {
    // Registry with a display name so the label is the human name, not the id.
    const named = {
      get: (id: string) =>
        id === 'mm'
          ? {
              manifest: {
                name: 'Mental model',
                contextExports: [
                  { key: 'model', label: 'Mental model', format: 'markdown', maxTokens: 1000 }
                ]
              }
            }
          : undefined
    } as unknown as PluginRegistry
    pluginStorageSet('c1', 'mm', contextStorageKey('model'), 'x'.repeat(40))
    const out = pluginContextContributions(named, 'c1', { mm: pinned(['model']) })
    expect(out).toEqual([{ id: 'mm', label: 'Mental model', tokens: 10 }])
  })

  it('sums value + guide and sorts contributors largest first', () => {
    const reg = fakeRegistry({
      a: [{ key: 'k', label: 'A', format: 'text', maxTokens: 1000 }],
      b: [{ key: 'k', label: 'B', format: 'text', maxTokens: 1000 }]
    })
    pluginStorageSet('c1', 'a', contextStorageKey('k'), 'x'.repeat(20)) // 20 chars → 5 tokens
    pluginStorageSet('c1', 'b', contextStorageKey('k'), 'x'.repeat(40)) // value 40 …
    pluginStorageSet('c1', 'b', guideStorageKey('k'), 'x'.repeat(40)) // … + guide 40 → 20 tokens
    const out = pluginContextContributions(reg, 'c1', { a: pinned(['k']), b: pinned(['k']) })
    expect(out.map((c) => c.id)).toEqual(['b', 'a'])
    expect(out.map((c) => c.tokens)).toEqual([20, 5])
  })

  it('excludes push-only exports and empty read-only exports', () => {
    const push = fakeRegistry({
      viz: [{ key: 'arch', label: 'Arch', format: 'json', maxTokens: 1000, inject: false }]
    })
    pluginStorageSet('c1', 'viz', contextStorageKey('arch'), 'x'.repeat(40))
    expect(pluginContextContributions(push, 'c1', { viz: pinned(['arch']) })).toEqual([])

    const ns = fakeRegistry({
      ns: [{ key: 'star', label: 'North Star', format: 'markdown', maxTokens: 500, readonly: true }]
    })
    expect(pluginContextContributions(ns, 'c1', { ns: pinned(['star']) })).toEqual([])
  })

  it('counts a plugin systemInstruction toward its contribution', () => {
    const si = {
      get: (id: string) =>
        id === 'instr'
          ? {
              manifest: {
                name: 'Instructions',
                systemInstruction: { key: 'instruction', maxTokens: 1000 }
              }
            }
          : undefined
    } as unknown as PluginRegistry
    pluginStorageSet('c1', 'instr', contextStorageKey('instruction'), 'x'.repeat(40))
    expect(
      pluginContextContributions(si, 'c1', { instr: { enabled: true, pinnedExports: [] } })
    ).toEqual([{ id: 'instr', label: 'Instructions', tokens: 10 }])
  })
})

describe('estimateTranscriptTokens', () => {
  const msg = (blocks: TranscriptMessage['blocks']): TranscriptMessage => ({
    uuid: 'u',
    role: 'user',
    blocks
  })

  it('is zero for an empty transcript', () => {
    expect(estimateTranscriptTokens([])).toBe(0)
  })

  it('counts text and thinking block characters at ~chars/4', () => {
    const t = estimateTranscriptTokens([
      msg([
        { kind: 'text', text: 'x'.repeat(40) },
        { kind: 'thinking', text: 'x'.repeat(40) }
      ])
    ])
    expect(t).toBe(20)
  })

  it('counts a tool_use name, input, and result output', () => {
    const t = estimateTranscriptTokens([
      msg([
        {
          kind: 'tool_use',
          toolUseId: 't1',
          name: 'Bash', // 4 chars
          input: 'ls', // JSON.stringify → "ls" = 4 chars
          result: { ok: true, output: 'ok' } // "ok" = 4 chars
        }
      ])
    ])
    expect(t).toBe(3) // round(12 / 4)
  })
})

describe('pluginValueOrDefault', () => {
  const dirRegistry = (id: string, dir: string): PluginRegistry =>
    ({ get: (x: string) => (x === id ? { dir } : undefined) }) as unknown as PluginRegistry

  it('uses the packaged default only until the key is written; respects an explicit clear', () => {
    const dir = join(userData, 'plug')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'defaults.json'),
      JSON.stringify({ 'ctx:instruction': 'DEFAULT', 'guide:model': 'GUIDE' })
    )
    const reg = dirRegistry('p', dir)
    // Never written → packaged default.
    expect(pluginValueOrDefault(reg, 'cX', 'p', contextStorageKey('instruction'))).toBe('DEFAULT')
    expect(pluginValueOrDefault(reg, 'cX', 'p', guideStorageKey('model'))).toBe('GUIDE')
    // Key absent from defaults → null (no default to apply).
    expect(pluginValueOrDefault(reg, 'cX', 'p', contextStorageKey('nope'))).toBe(null)
    // A written value wins over the default.
    pluginStorageSet('cX', 'p', contextStorageKey('instruction'), 'MINE')
    expect(pluginValueOrDefault(reg, 'cX', 'p', contextStorageKey('instruction'))).toBe('MINE')
    // An explicit empty string is respected — it does NOT snap back to the default.
    pluginStorageSet('cX', 'p', guideStorageKey('model'), '')
    expect(pluginValueOrDefault(reg, 'cX', 'p', guideStorageKey('model'))).toBe('')
  })
})
