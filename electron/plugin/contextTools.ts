import { z } from 'zod'
import { tool, createSdkMcpServer, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { PluginRegistry } from './PluginRegistry.js'
import type { ConversationPluginState } from '../shared/plugins.js'
import { pluginStorageGet, pluginStorageSet } from './pluginStorage.js'

// The "context document" engine (docs/CONTEXT_SYSTEM.md). A plugin declares `contextExports`;
// for each pinned export of an enabled plugin the host (a) injects its current value into the
// agent's context every turn and (b) auto-registers an MCP tool the agent calls to rewrite it.
// Values live in the plugin's per-conversation storage under `ctx:<key>` (so they survive Clear
// chat, restarts, and the pane being closed). Generic — no per-plugin backend.

const APPROX_CHARS_PER_TOKEN = 4

/** Storage key for an export's value (shared by the host API handlers and these helpers). */
export function contextStorageKey(exportKey: string): string {
  return `ctx:${exportKey}`
}

/**
 * Storage key for an export's user-authored usage guide — a fixed instruction the pane writes (via
 * the generic `storage` API) and the host injects alongside the value. Deliberately NOT under
 * `ctx:`, so the agent's `set_<plugin>__<key>` tool (which only writes `ctx:<key>`) can never
 * overwrite it: the doc is the agent's to maintain, the guide is the author's.
 */
export function guideStorageKey(exportKey: string): string {
  return `guide:${exportKey}`
}

/** Trim a stored value and cap it to the export's token budget (chars ≈ tokens × 4). */
function capValue(raw: unknown, cap: number): string {
  const v = typeof raw === 'string' ? raw.trim() : ''
  return v.length > cap ? v.slice(0, cap) + '\n…[truncated]' : v
}

/** MCP tool names must be identifier-safe; plugin ids are [a-z0-9-]. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_')
}

interface PinnedExport {
  pluginId: string
  key: string
  label: string
  format: string
  maxTokens: number
  inject: boolean
}

/** Every pinned export of every enabled plugin, resolved against the registry's manifests. */
function pinnedExports(
  registry: PluginRegistry,
  pluginState: Record<string, ConversationPluginState>
): PinnedExport[] {
  const out: PinnedExport[] = []
  for (const [pluginId, st] of Object.entries(pluginState)) {
    if (!st.enabled) continue
    const exports = registry.get(pluginId)?.manifest?.contextExports ?? []
    for (const ex of exports) {
      if (!st.pinnedExports.includes(ex.key)) continue
      out.push({
        pluginId,
        key: ex.key,
        label: ex.label,
        format: ex.format,
        maxTokens: ex.maxTokens,
        inject: ex.inject !== false
      })
    }
  }
  return out
}

/**
 * The `<atelier-context>` block prepended to each turn (or '' if nothing is pinned/non-empty).
 * Stripped from the displayed transcript by sessionStore so editable history stays clean.
 */
export function buildContextBlock(
  registry: PluginRegistry,
  conversationId: string,
  pluginState: Record<string, ConversationPluginState>
): string {
  const sections: string[] = []
  for (const ex of pinnedExports(registry, pluginState)) {
    if (!ex.inject) continue // push-only export: write-tool is registered, but never injected back
    const cap = ex.maxTokens * APPROX_CHARS_PER_TOKEN
    const value = capValue(
      pluginStorageGet(conversationId, ex.pluginId, contextStorageKey(ex.key)),
      cap
    )
    // The author's usage guide for this section: injected alongside the value, but the agent
    // never edits it (separate storage key; its set_ tool only writes the `ctx:` value).
    const guide = capValue(
      pluginStorageGet(conversationId, ex.pluginId, guideStorageKey(ex.key)),
      cap
    )
    if (!value && !guide) continue
    const head = guide
      ? `_How to use this section — fixed instructions from the author. Follow them; do not edit ` +
        `them or copy them into your updates._\n${guide}\n\n`
      : ''
    sections.push(`## ${ex.label}\n${head}${value}`.trimEnd())
  }
  if (sections.length === 0) return ''
  return (
    '<atelier-context>\n' +
    'Your persistent working state for this conversation, carried across turns — treat it as ' +
    'your own notes from earlier and continue it. Update any section by calling its set_* tool ' +
    'with the full new content.\n\n' +
    sections.join('\n\n') +
    '\n</atelier-context>'
  )
}

/**
 * The standing instruction fed to `systemPrompt.append`, concatenated from every enabled plugin
 * that declares `systemInstruction` in its manifest (value sourced from the same `ctx:<key>`
 * storage as a context export). Unlike buildContextBlock, this is NOT injected into the per-turn
 * user message — the host puts it at the top of the system prompt, so an unchanged instruction
 * stays prompt-cached across turns. Returns '' when no enabled plugin contributes one.
 */
export function buildSystemInstruction(
  registry: PluginRegistry,
  conversationId: string,
  pluginState: Record<string, ConversationPluginState>
): string {
  const parts: string[] = []
  for (const [pluginId, st] of Object.entries(pluginState)) {
    if (!st.enabled) continue
    const si = registry.get(pluginId)?.manifest?.systemInstruction
    if (!si) continue
    const raw = pluginStorageGet(conversationId, pluginId, contextStorageKey(si.key))
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) continue
    const cap = si.maxTokens * APPROX_CHARS_PER_TOKEN
    parts.push(value.length > cap ? value.slice(0, cap) + '\n…[truncated]' : value)
  }
  return parts.join('\n\n')
}

/**
 * The `mcpServers` option carrying one update tool per pinned export (or undefined if none).
 * Each tool rewrites the export's stored value in the main process, so the agent can update a
 * document whether or not its pane is open.
 */
export function buildContextMcpServers(
  registry: PluginRegistry,
  conversationId: string,
  pluginState: Record<string, ConversationPluginState>,
  onChange: (pluginId: string, key: string) => void
): Options['mcpServers'] | undefined {
  const tools = pinnedExports(registry, pluginState).map((ex) =>
    tool(
      `set_${sanitize(ex.pluginId)}__${sanitize(ex.key)}`,
      `Replace the full contents of your "${ex.label}". ` +
        (ex.inject
          ? `It is shown back to you as context every turn — `
          : `It is pushed to its pane but NOT fed back to you — `) +
        `send the complete new ${ex.format} content (not a diff).`,
      { content: z.string() },
      async (args: { content: string }) => {
        pluginStorageSet(conversationId, ex.pluginId, contextStorageKey(ex.key), args.content)
        onChange(ex.pluginId, ex.key)
        return { content: [{ type: 'text' as const, text: `Updated "${ex.label}".` }] }
      }
    )
  )
  if (tools.length === 0) return undefined
  return {
    atelier_context: createSdkMcpServer({ name: 'atelier_context', version: '1.0.0', tools })
  }
}
