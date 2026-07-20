import { join } from 'node:path'
import { z } from 'zod'
import {
  tool,
  createSdkMcpServer,
  type Options,
  type SdkMcpToolDefinition
} from '@anthropic-ai/claude-agent-sdk'
import type { ConversationPluginState, RegistryView } from '../shared/plugins.js'

// P4 S3: turn each enabled tool-contributing plugin's manifest `tools` into in-process MCP tools.
// The tool handler runs in main but does NO work itself — it forwards the call to the plugin's
// backend child process (via `invoke`) and returns whatever text it produces.

/** How a tool call reaches a plugin's backend child process. Returns the result text. */
export type InvokeBackend = (
  pluginId: string,
  backendPath: string,
  tool: string,
  input: unknown,
  timeoutMs?: number
) => Promise<string>

// Depth cap for nested JSON-Schema tool inputs — bounds a pathological manifest; deeper → z.unknown().
const SCHEMA_MAX_DEPTH = 4

/** One JSON-Schema-subset node → a Zod type. Unknown/too-deep constructs degrade to z.unknown()
 *  (a weird manifest must never throw — same philosophy as an invalid manifest surfacing, not crashing). */
function zodFromJsonSchema(node: unknown, depth: number): z.ZodTypeAny {
  if (depth > SCHEMA_MAX_DEPTH || node === null || typeof node !== 'object') return z.unknown()
  const n = node as Record<string, unknown>
  const type = typeof n.type === 'string' ? n.type : undefined
  let zt: z.ZodTypeAny
  switch (type) {
    case 'string':
      if (
        Array.isArray(n.enum) &&
        n.enum.length > 0 &&
        n.enum.every((e) => typeof e === 'string')
      ) {
        zt = z.enum(n.enum as [string, ...string[]])
      } else {
        zt = z.string()
      }
      break
    case 'number':
    case 'integer':
      zt = z.number()
      break
    case 'boolean':
      zt = z.boolean()
      break
    case 'array':
      zt = z.array(zodFromJsonSchema(n.items, depth + 1))
      break
    case 'object': {
      const props =
        n.properties && typeof n.properties === 'object'
          ? (n.properties as Record<string, unknown>)
          : {}
      const required = Array.isArray(n.required)
        ? n.required.filter((r): r is string => typeof r === 'string')
        : []
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [k, v] of Object.entries(props)) {
        const child = zodFromJsonSchema(v, depth + 1)
        shape[k] = required.includes(k) ? child : child.optional()
      }
      zt = z.object(shape)
      break
    }
    default:
      zt = z.unknown()
  }
  if (typeof n.description === 'string') zt = zt.describe(n.description)
  return zt
}

/**
 * Convert a manifest `inputSchema` descriptor map into a Zod raw shape for `tool()`. Each field's
 * descriptor is EITHER the legacy shorthand string (`"string"|"number"|"boolean"`, trailing `?` =
 * optional) OR a JSON-Schema-subset object (`{ type, items, properties, required, enum, description,
 * optional }`). Manifests can't carry real Zod, so this is the serializable subset the SDK tool needs;
 * unknown constructs degrade to `z.unknown()` rather than throwing.
 */
export function jsonSchemaToZodShape(
  desc: Record<string, unknown> | undefined
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  if (!desc) return shape
  for (const [field, raw] of Object.entries(desc)) {
    if (typeof raw === 'string') {
      // Legacy shorthand: "string" | "number" | "boolean", trailing "?" marks optional.
      const optional = raw.endsWith('?')
      const base = optional ? raw.slice(0, -1) : raw
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
    } else {
      // JSON-Schema-subset object. Top-level fields are required unless the node sets `optional:true`.
      const zt = zodFromJsonSchema(raw, 1)
      const optional = !!(
        raw &&
        typeof raw === 'object' &&
        (raw as { optional?: unknown }).optional
      )
      shape[field] = optional ? zt.optional() : zt
    }
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
  registry: RegistryView,
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
            const text = await invoke(pluginId, backendPath, spec.name, input, spec.timeoutMs)
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
  registry: RegistryView,
  pluginState: Record<string, ConversationPluginState>,
  invoke: InvokeBackend
): Options['mcpServers'] | undefined {
  const tools = buildPluginTools(registry, pluginState, invoke)
  if (tools.length === 0) return undefined
  return {
    atelier_plugins: createSdkMcpServer({ name: 'atelier_plugins', version: '1.0.0', tools })
  }
}
