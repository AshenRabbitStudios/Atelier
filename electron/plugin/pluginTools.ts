import { join } from 'node:path'
import { z } from 'zod'
import {
  tool,
  createSdkMcpServer,
  type Options,
  type SdkMcpToolDefinition
} from '@anthropic-ai/claude-agent-sdk'
import type { PluginRegistry } from './PluginRegistry.js'
import type { ConversationPluginState } from '../shared/plugins.js'

// P4 S3: turn each enabled tool-contributing plugin's manifest `tools` into in-process MCP tools.
// The tool handler runs in main but does NO work itself — it forwards the call to the plugin's
// backend child process (via `invoke`) and returns whatever text it produces.

/** How a tool call reaches a plugin's backend child process. Returns the result text. */
export type InvokeBackend = (
  pluginId: string,
  backendPath: string,
  tool: string,
  input: unknown
) => Promise<string>

/**
 * Convert a manifest `inputSchema` descriptor (a `{ field: "string"|"number"|"boolean" }` map, with
 * a trailing `?` marking optional) into a Zod raw shape for `tool()`. Unknown types → `z.unknown()`.
 * Manifests can't carry real Zod, so this is the serializable subset the SDK tool needs.
 */
export function jsonSchemaToZodShape(
  desc: Record<string, unknown> | undefined
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  if (!desc) return shape
  for (const [field, raw] of Object.entries(desc)) {
    const spec = String(raw)
    const optional = spec.endsWith('?')
    const base = optional ? spec.slice(0, -1) : spec
    let zt: z.ZodTypeAny
    switch (base) {
      case 'string':
        zt = z.string()
        break
      case 'number':
        zt = z.number()
        break
      case 'boolean':
        zt = z.boolean()
        break
      default:
        zt = z.unknown()
    }
    shape[field] = optional ? zt.optional() : zt
  }
  return shape
}

/**
 * The SDK tool definitions for every enabled tool-plugin's contributed tools. A plugin contributes
 * tools only when it declares a `backend`, the `tools` permission, and at least one `tools[]` entry.
 * Each tool's handler does no work itself — it forwards to the plugin's backend child via `invoke`.
 * (Split from the server wrapper so the handlers are unit-testable without an `McpServer`.)
 */
export function buildPluginTools(
  registry: PluginRegistry,
  pluginState: Record<string, ConversationPluginState>,
  invoke: InvokeBackend
): SdkMcpToolDefinition[] {
  const defs: SdkMcpToolDefinition[] = []
  for (const [pluginId, state] of Object.entries(pluginState)) {
    if (!state.enabled) continue
    const manifest = registry.get(pluginId)?.manifest
    if (!manifest?.backend) continue
    if (!manifest.permissions.includes('tools')) continue
    if (manifest.tools.length === 0) continue
    const dir = registry.dirOf(pluginId)
    if (!dir) continue
    const backendPath = join(dir, manifest.backend)
    for (const spec of manifest.tools) {
      defs.push(
        tool(
          spec.name,
          spec.description,
          jsonSchemaToZodShape(spec.inputSchema),
          async (input: unknown) => {
            const text = await invoke(pluginId, backendPath, spec.name, input)
            return { content: [{ type: 'text' as const, text }] }
          }
        )
      )
    }
  }
  return defs
}

/**
 * The `mcpServers` entry exposing every enabled tool-plugin's tools (or undefined if none).
 */
export function buildPluginToolServers(
  registry: PluginRegistry,
  pluginState: Record<string, ConversationPluginState>,
  invoke: InvokeBackend
): Options['mcpServers'] | undefined {
  const tools = buildPluginTools(registry, pluginState, invoke)
  if (tools.length === 0) return undefined
  return {
    atelier_plugins: createSdkMcpServer({ name: 'atelier_plugins', version: '1.0.0', tools })
  }
}
