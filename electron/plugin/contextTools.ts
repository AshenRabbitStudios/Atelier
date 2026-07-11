import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { tool, createSdkMcpServer, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { PluginRegistry } from './PluginRegistry.js'
import type { ConversationPluginState } from '../shared/plugins.js'
import { pluginStorageGet, pluginStorageSet } from './pluginStorage.js'

// The "context document" engine (docs/CONTEXT_SYSTEM.md). A plugin declares `contextExports`;
// for each pinned export of an enabled plugin the host (a) injects its current value into the
// agent's context every turn and (b) auto-registers TWO MCP tools the agent uses to update it:
// `set_<plugin>__<key>` (replace the whole value — first write / deliberate re-synthesis) and
// `edit_<plugin>__<key>` (targeted find-and-replace — a small change that leaves the rest of the
// document verbatim, avoiding the silent, compounding drift a full rewrite risks on untouched
// content). Values live in the plugin's per-conversation storage under `ctx:<key>` (so they
// survive Clear chat, restarts, and the pane being closed). Generic — no per-plugin backend.

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

// Packaged per-plugin defaults: a `defaults.json` (storageKey → value) shipped in the plugin folder
// seeds a key the conversation has never written. Lets a plugin ship with starter content (its usage
// guides, a standing instruction, …) that every fresh conversation picks up. Cached per dir.
const defaultsCache = new Map<string, Record<string, unknown>>()
function pluginDefaults(dir: string): Record<string, unknown> {
  let d = defaultsCache.get(dir)
  if (!d) {
    try {
      d = JSON.parse(readFileSync(join(dir, 'defaults.json'), 'utf8')) as Record<string, unknown>
    } catch {
      d = {}
    }
    defaultsCache.set(dir, d)
  }
  return d
}

/**
 * The stored value for (conversation, plugin, storageKey), or the plugin's packaged default when the
 * key has *never* been written (storage returns null). An explicit empty string is left as-is — a
 * deliberate clear is respected and does not snap back to the default.
 */
export function pluginValueOrDefault(
  registry: PluginRegistry,
  conversationId: string,
  pluginId: string,
  storageKey: string
): unknown {
  const stored = pluginStorageGet(conversationId, pluginId, storageKey)
  if (stored !== null) return stored
  const dir = registry.get(pluginId)?.dir
  return dir ? (pluginDefaults(dir)[storageKey] ?? null) : null
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
  description?: string
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
        inject: ex.inject !== false,
        description: ex.description
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
      pluginValueOrDefault(registry, conversationId, ex.pluginId, contextStorageKey(ex.key)),
      cap
    )
    // The author's usage guide for this section: injected alongside the value, but the agent
    // never edits it (separate storage key; its set_ tool only writes the `ctx:` value).
    const guide = capValue(
      pluginValueOrDefault(registry, conversationId, ex.pluginId, guideStorageKey(ex.key)),
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
    const raw = pluginValueOrDefault(registry, conversationId, pluginId, contextStorageKey(si.key))
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) continue
    const cap = si.maxTokens * APPROX_CHARS_PER_TOKEN
    parts.push(value.length > cap ? value.slice(0, cap) + '\n…[truncated]' : value)
  }
  return parts.join('\n\n')
}

/** Count non-overlapping literal occurrences of `needle` in `hay` (no regex; needle may hold metachars). */
function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = hay.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = hay.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * The `mcpServers` option carrying the update tools for every pinned export (or undefined if none).
 * Each export gets TWO tools — `set_<plugin>__<key>` (full replace) and `edit_<plugin>__<key>`
 * (targeted find-and-replace) — both writing the export's stored value in the main process, so the
 * agent can update a document whether or not its pane is open. Both fire `onChange` so the owning
 * pane refreshes. The read-modify-write in `edit_` is safe without locking: Node's single thread
 * means it can't interleave with a pane's `context.set` write to the same file.
 */
export function buildContextMcpServers(
  registry: PluginRegistry,
  conversationId: string,
  pluginState: Record<string, ConversationPluginState>,
  onChange: (pluginId: string, key: string) => void
): Options['mcpServers'] | undefined {
  const tools = pinnedExports(registry, pluginState).flatMap((ex) => {
    const base = `${sanitize(ex.pluginId)}__${sanitize(ex.key)}`
    const injectionNote = ex.inject
      ? `It is shown back to you as context every turn — `
      : `It is pushed to its pane but NOT fed back to you — `

    const setTool = tool(
      `set_${base}`,
      `Replace the ENTIRE contents of your "${ex.label}". ` +
        injectionNote +
        `send the complete new ${ex.format} content (not a diff). Use this for the first write or a ` +
        `deliberate full rewrite; for a small change to an existing value prefer edit_${base}, which ` +
        `leaves the rest of the document verbatim.` +
        (ex.description ? ` ${ex.description}` : ''),
      { content: z.string() },
      async (args: { content: string }) => {
        pluginStorageSet(conversationId, ex.pluginId, contextStorageKey(ex.key), args.content)
        onChange(ex.pluginId, ex.key)
        return { content: [{ type: 'text' as const, text: `Updated "${ex.label}".` }] }
      }
    )

    const editTool = tool(
      `edit_${base}`,
      `Make a TARGETED edit to your "${ex.label}": replace an exact snippet, like a code editor's ` +
        `find-and-replace. Preferred over set_ for small changes — it preserves the rest of the ` +
        `document byte-for-byte, avoiding the drift a full rewrite risks on untouched content. ` +
        `"old_string" must match the current ${ex.format} EXACTLY and occur exactly once (include ` +
        `enough surrounding text to be unique) unless you pass replace_all: true. On a not-found or ` +
        `not-unique error, adjust old_string or fall back to set_${base}.`,
      {
        old_string: z.string().describe('Exact text to find in the current value (verbatim, may span lines).'),
        new_string: z.string().describe('Text to replace it with.'),
        replace_all: z
          .boolean()
          .optional()
          .describe('Replace every occurrence instead of requiring old_string to be unique.')
      },
      async (args: { old_string: string; new_string: string; replace_all?: boolean }) => {
        const fail = (text: string) => ({
          content: [{ type: 'text' as const, text }],
          isError: true as const
        })
        const raw = pluginValueOrDefault(
          registry,
          conversationId,
          ex.pluginId,
          contextStorageKey(ex.key)
        )
        const current = typeof raw === 'string' ? raw : ''
        if (!current)
          return fail(`"${ex.label}" is empty — nothing to edit. Use set_${base} to write it first.`)
        if (args.old_string === '') return fail('old_string is empty — provide the snippet to replace.')
        if (args.old_string === args.new_string)
          return fail('old_string and new_string are identical — no change to make.')

        const count = countOccurrences(current, args.old_string)
        if (count === 0)
          return fail(
            `old_string not found in "${ex.label}". Match the text exactly as it appears in your ` +
              `context (note the injected view is trimmed and may be truncated at the end, so anchor ` +
              `on interior text), or use set_${base} to rewrite the whole document.`
          )
        if (count > 1 && !args.replace_all)
          return fail(
            `old_string occurs ${count} times in "${ex.label}" — not unique. Add surrounding text to ` +
              `target one occurrence, or pass replace_all: true.`
          )

        // split/join, not String.replace: a literal replacement that never interprets `$` patterns
        // in new_string. Safe for both the single (count===1) and replace_all branches.
        const updated = current.split(args.old_string).join(args.new_string)
        pluginStorageSet(conversationId, ex.pluginId, contextStorageKey(ex.key), updated)
        onChange(ex.pluginId, ex.key)
        const n = args.replace_all ? count : 1
        return {
          content: [
            { type: 'text' as const, text: `Edited "${ex.label}" (${n} replacement${n === 1 ? '' : 's'}).` }
          ]
        }
      }
    )

    return [setTool, editTool]
  })
  if (tools.length === 0) return undefined
  return {
    atelier_context: createSdkMcpServer({ name: 'atelier_context', version: '1.0.0', tools })
  }
}
