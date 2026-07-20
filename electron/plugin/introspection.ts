import { tool, createSdkMcpServer, type Options } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ConversationPluginState, Manifest, RegistryView } from '../shared/plugins.js'
import { pluginAuthoringGuide } from './pluginAuthoringGuide.js'

// Host-level environment self-awareness (docs/ENVIRONMENT_AWARENESS.md). Every Atelier agent
// instance is otherwise blind to the fact that it runs inside Atelier: the per-conversation context
// injection and system-instruction append only fire for plugins the user has *enabled*, so a fresh
// conversation is never told where it is or what plugins exist. This module supplies two always-on
// pieces (composed in main.ts, independent of enablement):
//   1. buildEnvironmentBriefing — a stable `<atelier-environment>` block for the system prompt.
//   2. buildAtelierToolServer   — a built-in `atelier` MCP server (`list_plugins`/`describe_plugin`)
//      the agent calls to inspect a plugin's live, per-conversation state and its full contract.
// The briefing carries only install-level facts (Atelier + the plugin catalog + this cwd) so it
// stays prompt-cached; anything per-conversation (what's enabled/pinned here) lives in the tools.

/** Valid, manifest-bearing plugins, in the registry's stable id order. */
function catalog(registry: RegistryView): { id: string; manifest: Manifest; workspace: boolean }[] {
  return registry
    .list()
    .filter((p) => p.valid && p.manifest)
    .map((p) => ({
      id: p.id,
      manifest: p.manifest as Manifest,
      workspace: p.scope === 'workspace'
    }))
}

/** One-line summary a plugin shows in the catalog: its description, else its name. */
function oneLine(m: Manifest): string {
  const d = (m.description ?? '').trim()
  return (d ? d.split('\n')[0] : m.name).trim()
}

/**
 * The `<atelier-environment>` block prepended to the system-prompt append for *every* conversation,
 * regardless of which plugins are enabled. Deliberately install-level and stable (catalog + cwd) so
 * an unchanged value stays byte-identical across turns and keeps the system block cached.
 */
export function buildEnvironmentBriefing(registry: RegistryView, cwd?: string): string {
  const plugins = catalog(registry)
  const lines = plugins.map(
    (p) => `- ${p.id}${p.workspace ? ' [workspace]' : ''} — ${oneLine(p.manifest)}`
  )
  const list = lines.length > 0 ? lines.join('\n') : '- (none discovered)'
  return (
    '<atelier-environment>\n' +
    'You are running as an isolated agent instance inside Atelier — a local, single-user Electron ' +
    'workbench for working with Claude. Each conversation is its own instance with its own working ' +
    'directory, session, transcript, and set of enabled plugins; other conversations cannot see ' +
    'yours.\n\n' +
    (cwd ? `Your working directory is: ${cwd}\n\n` : '') +
    'Plugins extend what you and the user can do. A plugin may contribute any of: a docked panel ' +
    '(UI the user sees), tools you can call, and "context documents" — persistent per-conversation ' +
    'working state that is injected back into your context each turn and that you update through a ' +
    'generated set_* tool. A plugin is only active for a conversation once the user enables it here, ' +
    'so the plugins below exist in this install but may or may not be enabled for you right now.\n\n' +
    'Plugins available in this Atelier install:\n' +
    list +
    '\n\n' +
    'To find out which of these are enabled for this conversation, what tools and context documents ' +
    'a plugin contributes, and how to use it, call the `list_plugins` and `describe_plugin` tools ' +
    '(the built-in `atelier` tool server, always available to you). To author a new plugin, call ' +
    '`plugin_authoring_guide` first for the manifest contract, host API, and rules. A plugin marked ' +
    '[workspace] lives under this project’s `.atelier/plugins`; you can author one there yourself ' +
    '(it auto-enables for this conversation and travels with the repo).\n' +
    '</atelier-environment>'
  )
}

/** Is `pluginId` enabled for this conversation, and which of its exports are pinned? */
function stateOf(
  pluginState: Record<string, ConversationPluginState>,
  pluginId: string
): { enabled: boolean; pinned: string[] } {
  const st = pluginState[pluginId]
  return { enabled: !!st?.enabled, pinned: st?.pinnedExports ?? [] }
}

/** The `list_plugins` catalog text: every installed plugin with a one-liner + enabled marker. */
export function listPluginsText(
  registry: RegistryView,
  pluginState: Record<string, ConversationPluginState>
): string {
  const rows = catalog(registry).map((p) => {
    const { enabled } = stateOf(pluginState, p.id)
    return `- ${p.id}${enabled ? ' [enabled]' : ''} — ${oneLine(p.manifest)}`
  })
  return rows.length
    ? `Plugins installed in this Atelier:\n${rows.join('\n')}`
    : 'No plugins are installed.'
}

/** Human-readable, multi-section report of a single plugin's contract + live conversation state. */
export function describePlugin(
  registry: RegistryView,
  pluginState: Record<string, ConversationPluginState>,
  id: string
): string {
  const found = registry.get(id)
  if (!found) return `No plugin with id "${id}" is installed. Call list_plugins to see the catalog.`
  if (!found.valid || !found.manifest) {
    return `Plugin "${id}" is present but its manifest is invalid: ${found.error ?? 'unknown error'}.`
  }
  const m = found.manifest
  const { enabled, pinned } = stateOf(pluginState, id)
  const out: string[] = []
  const scope =
    found.scope === 'workspace' ? ' — workspace (in this project’s .atelier/plugins)' : ''
  out.push(`${m.name} (id: ${m.id}) v${m.version} — kind: ${m.kind}${scope}`)
  if (m.description) out.push(m.description.trim())
  out.push(
    enabled
      ? `Status: ENABLED for this conversation${pinned.length ? ` (pinned context: ${pinned.join(', ')})` : ''}.`
      : 'Status: NOT enabled for this conversation. The user must enable it before its panel, ' +
          'tools, or context documents are active for you.'
  )
  if (m.permissions.length) out.push(`Permissions: ${m.permissions.join(', ')}.`)

  if (m.tools.length) {
    out.push(
      'Tools it contributes:\n' + m.tools.map((t) => `  - ${t.name} — ${t.description}`).join('\n')
    )
  }
  if (m.contextExports.length) {
    out.push(
      'Context documents (each is a persistent doc; you update it via its set_* tool):\n' +
        m.contextExports
          .map((e) => {
            const flags = e.readonly
              ? ' [read-only: user-authored, injected but you have no tool to change it]'
              : e.inject === false
                ? ' [push-only: not fed back to you]'
                : ''
            const desc = e.description ? ` — ${e.description}` : ''
            return `  - "${e.label}" (key: ${e.key}, ${e.format})${flags}${desc}`
          })
          .join('\n')
    )
  }
  if (m.systemInstruction) {
    out.push(
      `Contributes a standing system instruction (key: ${m.systemInstruction.key}) when enabled.`
    )
  }
  if (!m.tools.length && !m.contextExports.length && !m.systemInstruction) {
    out.push('This plugin contributes a panel only (no agent-facing tools or context documents).')
  }
  return out.join('\n\n')
}

/**
 * The built-in `atelier` MCP server, always registered on every conversation's query (not gated on
 * any plugin being enabled) so the agent can always inspect its environment. Reads live registry +
 * per-conversation state at call time, so enabling/disabling a plugin needs no rebind to be seen.
 */
export function buildAtelierToolServer(
  registry: RegistryView,
  pluginState: Record<string, ConversationPluginState>
): NonNullable<Options['mcpServers']> {
  const listPlugins = tool(
    'list_plugins',
    'List every plugin installed in this Atelier, with a one-line description and whether it is ' +
      'enabled for this conversation. Use describe_plugin for a specific one.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: listPluginsText(registry, pluginState) }]
    })
  )
  const describeTool = tool(
    'describe_plugin',
    'Describe one plugin in detail: what it is for, whether it is enabled for this conversation, ' +
      'its permissions, the tools it contributes, and its context documents. Pass the plugin id ' +
      '(see list_plugins).',
    { id: z.string().min(1).describe('The plugin id, e.g. "cognition".') },
    async (args: { id: string }) => ({
      content: [{ type: 'text' as const, text: describePlugin(registry, pluginState, args.id) }]
    })
  )
  const authoringGuide = tool(
    'plugin_authoring_guide',
    'Get the full spec for authoring an Atelier plugin: the manifest.json contract, the sandbox ' +
      'host API (window.atelier), the hard rules, and a minimal working example. Read this BEFORE ' +
      'creating or editing a plugin so you follow the signature and invariants exactly.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: pluginAuthoringGuide() }]
    })
  )
  return {
    atelier: createSdkMcpServer({
      name: 'atelier',
      version: '1.0.0',
      tools: [listPlugins, describeTool, authoringGuide]
    })
  }
}
