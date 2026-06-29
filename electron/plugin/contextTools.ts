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
        maxTokens: ex.maxTokens
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
    const raw = pluginStorageGet(conversationId, ex.pluginId, contextStorageKey(ex.key))
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) continue
    const cap = ex.maxTokens * APPROX_CHARS_PER_TOKEN
    const text = value.length > cap ? value.slice(0, cap) + '\n…[truncated]' : value
    sections.push(`## ${ex.label}\n${text}`)
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
      `Replace the full contents of your "${ex.label}". It is shown back to you as context ` +
        `every turn — send the complete new ${ex.format} content (not a diff).`,
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
