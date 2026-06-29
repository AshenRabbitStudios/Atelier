import { z } from 'zod'

// The plugin contract's shared types + Zod schemas (PLUGIN_API.md / PLUGIN_ARCHITECTURE.md).
// Validated on discovery (main) and at the host RPC boundary; imported by the renderer for types.

export const DOCK_POSITIONS = ['left', 'right', 'bottom', 'center', 'float'] as const
export type DockPosition = (typeof DOCK_POSITIONS)[number]

export const PLUGIN_PERMISSIONS = [
  'data:subscribe',
  'data:publish',
  'agent:read',
  'agent:send',
  'storage',
  'tools',
  'context'
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

export const PluginKind = z.enum(['panel', 'tool', 'both'])

// An agent tool a plugin contributes (registered on the SDK in P4; declared now for the manifest).
export const PluginToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).optional()
})

// A pinnable context export (injected into agent context in P4; declared now so persistence is
// correct from day one — PLUGIN_ARCHITECTURE.md §2).
export const ContextExportSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  format: z.enum(['markdown', 'text', 'json']).default('text'),
  maxTokens: z.number().int().positive().max(20000).default(1500)
})
export type ContextExport = z.infer<typeof ContextExportSchema>

// A standing instruction the plugin contributes to the top system prompt (docs/CONTEXT_SYSTEM.md).
// Sourced from the same `ctx:<key>` storage as a context export, but the host feeds it to
// `systemPrompt.append` (read at query-build time, replayed verbatim) instead of injecting it into
// the per-turn user message — so an unchanged instruction stays prompt-cached across turns.
export const SystemInstructionSchema = z.object({
  key: z.string().min(1),
  maxTokens: z.number().int().positive().max(20000).default(2000)
})
export type SystemInstruction = z.infer<typeof SystemInstructionSchema>

export const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase letters, digits, and hyphens only'),
  name: z.string().min(1),
  version: z.string().min(1),
  // Optional single-path 16px line-icon `d` string (DESIGN_SYSTEM.md §6), shown in the sidebar so
  // each plugin is distinguishable when collapsed. Falls back to a generic plug icon if omitted.
  icon: z.string().min(1).optional(),
  kind: PluginKind.default('panel'),
  entry: z.string().min(1).optional(), // required when kind includes "panel" — checked in registry
  backend: z.string().min(1).optional(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).default([]),
  defaultDock: z.enum(DOCK_POSITIONS).default('right'),
  tools: z.array(PluginToolSchema).default([]),
  contextExports: z.array(ContextExportSchema).default([]),
  systemInstruction: SystemInstructionSchema.optional()
})
export type Manifest = z.infer<typeof ManifestSchema>

/** One folder under /plugins after discovery: valid+manifest, or invalid+error (never throws). */
export interface DiscoveredPlugin {
  id: string // folder name (authoritative; must equal manifest.id when valid)
  dir: string
  valid: boolean
  error?: string
  manifest?: Manifest
}

/** Per-conversation plugin state: which are enabled, which exports are pinned to context. */
export interface ConversationPluginState {
  enabled: boolean
  pinnedExports: string[]
}
