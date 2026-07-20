import { z } from 'zod'

// The plugin contract's shared types + Zod schemas (PLUGIN_API.md / PLUGIN_ARCHITECTURE.md).
// Validated on discovery (main) and at the host RPC boundary; imported by the renderer for types.

export const DOCK_POSITIONS = ['left', 'right', 'bottom', 'center', 'float'] as const
export type DockPosition = (typeof DOCK_POSITIONS)[number]

export const PLUGIN_PERMISSIONS = [
  'data:subscribe',
  'data:publish',
  // Write a UTF-8 text file inside the conversation cwd (`atelier.data.writeFile`). A distinct
  // coupling class from reading/observing — mutating the workspace — so a plugin declares it apart
  // from data:subscribe.
  'data:write',
  'agent:read',
  'agent:send',
  'storage',
  'tools',
  'context',
  'net:fetch',
  // A live, host-owned Chromium surface (Electron <webview>) composited over the pane and driven
  // via `atelier.browser.*`. The page runs real JS in its own guest process; the plugin only sends
  // commands and receives extracted state — page content can never reach the atelier bridge.
  'browser:embed',
  // Read-only, non-recursive directory listing inside the conversation cwd (`atelier.fs.list`). A
  // narrower reach than `data:subscribe` (which tails file contents) — it only enumerates names.
  'fs:list',
  // Open a cwd-scoped file in the OS default handler (`atelier.shell.openPath`). Hands a path to the
  // OS shell — a distinct coupling class from reading, so declared apart.
  'shell:open',
  // Stage text into THIS conversation's chat composer without sending (`atelier.agent.compose`).
  // Narrower than `agent:send` (which submits a turn) — it only pre-fills the input box.
  'agent:compose',
  // OS-level attention: notifications, taskbar flash/badge, window-focus queries (`atelier.os.*`).
  'os:notify'
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

// Channel-namespace prefix for the DataBus URL source. Network reach is a capability class of its
// own, so subscribing to a `url:` channel additionally requires the `net:fetch` permission — plain
// `data:subscribe` only grants conversation-scoped sources (files, bash taps). Shared here because
// the renderer (PluginPane) enforces the gate and main (DataBus) owns the source.
export const URL_CHANNEL_PREFIX = 'url:'

export const PluginKind = z.enum(['panel', 'tool', 'both'])

// An agent tool a plugin contributes (registered on the SDK in P4; declared now for the manifest).
// `inputSchema` is a `{ field: descriptor }` map where a descriptor is EITHER the legacy shorthand
// string ("string"|"number"|"boolean", trailing "?" = optional) OR a JSON-Schema-subset object
// ({ type, items, properties, required, enum, description, optional }). `timeoutMs` overrides the
// default 30s per-call cap for a long-running tool (e.g. a build).
export const PluginToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(600000).optional()
})

// A pinnable context export (injected into agent context in P4; declared now so persistence is
// correct from day one — PLUGIN_ARCHITECTURE.md §2).
export const ContextExportSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  format: z.enum(['markdown', 'text', 'json']).default('text'),
  maxTokens: z.number().int().positive().max(20000).default(1500),
  // When false, the host still registers the agent's `set_<plugin>__<key>` write-tool (when pinned)
  // but does NOT inject the value back into the agent's context each turn — a *push-only* export
  // (e.g. a large scene the agent sends to a pane but doesn't want re-fed to itself). Default true
  // preserves the original sync behavior. Injection is thus per-export, not all-or-nothing.
  inject: z.boolean().default(true),
  // When true, the export is READ-ONLY to the agent: its value is injected into context each turn
  // (so the agent is steered by it) but NO `set_`/`edit_` write-tool is registered — only the pane
  // (i.e. the user) can change it. The mirror image of a push-only export. Used for a user-authored
  // directive like the cognition "north star". Injected only when non-empty. Default false keeps the
  // normal read-write behavior.
  readonly: z.boolean().default(false),
  // Optional extra guidance appended to the agent's `set_<plugin>__<key>` write-tool description —
  // e.g. the exact JSON shape a command export expects. Lets a push-only channel be self-documenting
  // so the agent doesn't have to infer the payload format.
  description: z.string().optional()
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
  // Optional prose describing what the plugin is for — its intention and use. Surfaced in the
  // always-on environment briefing (one-line catalog entry) and in the `describe_plugin` tool
  // (full text). May be multi-line. Absent → the plugin still appears in the catalog by name.
  description: z.string().min(1).optional(),
  // Optional single-path 16px line-icon `d` string (DESIGN_SYSTEM.md §6), shown in the sidebar so
  // each plugin is distinguishable when collapsed. Falls back to a generic plug icon if omitted.
  icon: z.string().min(1).optional(),
  kind: PluginKind.default('panel'),
  entry: z.string().min(1).optional(), // required when kind includes "panel" — checked in registry
  backend: z.string().min(1).optional(),
  // When true the backend is a long-running SERVICE: spawned when the plugin is first enabled in a
  // conversation (not lazily on a tool call) and kept alive until it's disabled in the last one. A
  // service may push onto DataBus channels (needs `data:publish`). Requires `backend` (checked in
  // the registry). Default false = an on-demand tool responder (spawn on first call, idle otherwise).
  service: z.boolean().default(false),
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
  // Discovery source (Phase 7). Absent/'global' = the app-wide /plugins catalog; 'workspace' = a
  // plugin under the conversation's `<cwd>/.atelier/plugins`. `workspaceKey` (a stable hash of the
  // cwd) is set for workspace plugins so the renderer can build the encoded asset host.
  scope?: 'global' | 'workspace'
  workspaceKey?: string
}

/** The read surface every plugin consumer needs (global registry OR a merged global+workspace view).
 *  `PluginRegistry` satisfies it structurally; the merged view (registryView.ts) implements it too. */
export interface RegistryView {
  get(id: string): DiscoveredPlugin | undefined
  dirOf(id: string): string | null
  list(): DiscoveredPlugin[]
}

// ---- Workspace plugin asset host encoding (Phase 7) ----
// A plugin frame loads over `atelier-plugin://<host>/`. A global plugin's host is just its id; a
// workspace plugin's host embeds a fixed-length cwd hash so the protocol handler resolves it against
// the right workspace registry (ids can collide across workspaces). One encode/decode pair, shared by
// the protocol handler, PluginPane (frame src), and the injected runtime (which reads location.host
// back into the bare pluginId) — three hand-rolled parsers is how this drifts.
export const WORKSPACE_KEY_LEN = 12
const WORKSPACE_HOST_RE = /^w--([0-9a-f]{12})--(.+)$/

/** Build the asset host for a plugin frame. Global → the bare id; workspace → `w--<key>--<id>`. */
export function encodePluginHost(pluginId: string, workspaceKey?: string): string {
  return workspaceKey ? `w--${workspaceKey}--${pluginId}` : pluginId
}

/** Parse an asset host back to its bare id (+ workspaceKey when it is a workspace host). The
 *  fixed-length key makes the split unambiguous even when the id itself contains `--`. */
export function decodePluginHost(host: string): { pluginId: string; workspaceKey?: string } {
  const m = WORKSPACE_HOST_RE.exec(host)
  return m ? { pluginId: m[2], workspaceKey: m[1] } : { pluginId: host }
}

/** Per-conversation plugin state: which are enabled, which exports are pinned to context. */
export interface ConversationPluginState {
  enabled: boolean
  pinnedExports: string[]
}
