import type { DockviewApi } from 'dockview'
import type { DockPosition } from '@shared/plugins'

// Dockview docking directions we map the plugin dock positions onto.
const DIRECTION: Partial<Record<DockPosition, 'left' | 'right' | 'below'>> = {
  left: 'left',
  right: 'right',
  bottom: 'below'
}

/**
 * Thin wrapper over Dockview so the rest of the app never touches the docking
 * library directly (swappable per CLAUDE.md). P0 only needs to add a chat panel;
 * P2 grows this with float/serialize/restore.
 */
export class LayoutService {
  constructor(private readonly api: DockviewApi) {}

  addClaude(instanceId: string, title = 'Claude'): void {
    const id = 'claude'
    if (this.api.getPanel(id)) return
    this.api.addPanel({
      id,
      component: 'claude',
      title,
      params: { instanceId }
    })
  }

  /** Point the Claude pane at a different conversation (re-mounts with a fresh transcript). */
  setClaudeInstance(instanceId: string): void {
    const existing = this.api.getPanel('claude')
    if (existing) this.api.removePanel(existing)
    this.api.addPanel({
      id: 'claude',
      component: 'claude',
      title: 'Claude',
      params: { instanceId }
    })
  }

  // ---- Plugin panes (P3) ----

  addPlugin(pluginId: string, title: string, position: DockPosition = 'right'): void {
    const id = `plugin:${pluginId}`
    if (this.api.getPanel(id)) return
    // AddPanelOptions is a discriminated union: floating and position are mutually exclusive,
    // so each variant is built explicitly rather than via conditional spread.
    const base = { id, component: 'plugin', title, params: { pluginId } }
    const dir = DIRECTION[position]
    if (position === 'float') this.api.addPanel({ ...base, floating: true })
    else if (dir) this.api.addPanel({ ...base, position: { direction: dir } })
    else this.api.addPanel(base)
  }

  /** Re-dock a plugin pane to a new region (remove + re-add — robust across regions/float). */
  dockPlugin(pluginId: string, position: DockPosition): void {
    const panel = this.api.getPanel(`plugin:${pluginId}`)
    const title = panel?.title ?? pluginId
    if (panel) this.api.removePanel(panel)
    this.addPlugin(pluginId, title, position)
  }

  setPluginTitle(pluginId: string, title: string): void {
    this.api.getPanel(`plugin:${pluginId}`)?.setTitle(title)
  }

  removePlugin(pluginId: string): void {
    const panel = this.api.getPanel(`plugin:${pluginId}`)
    if (panel) this.api.removePanel(panel)
  }

  hasPlugin(pluginId: string): boolean {
    return Boolean(this.api.getPanel(`plugin:${pluginId}`))
  }

  // ---- Per-conversation layout serialization (SPEC §4.5) ----

  serialize(): unknown {
    return this.api.toJSON()
  }

  /** Restore a previously serialized layout. Throws if the JSON is incompatible. */
  restore(layout: unknown): void {
    this.api.fromJSON(layout as Parameters<DockviewApi['fromJSON']>[0])
  }

  clear(): void {
    this.api.clear()
  }

  hasPanels(): boolean {
    return this.api.panels.length > 0
  }

  onLayoutChange(cb: () => void): () => void {
    const d = this.api.onDidLayoutChange(cb)
    return () => d.dispose()
  }
}
