import type { DockviewApi } from 'dockview'

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
    this.api.addPanel({ id: 'claude', component: 'claude', title: 'Claude', params: { instanceId } })
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
