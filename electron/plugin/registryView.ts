import type { DiscoveredPlugin, RegistryView } from '../shared/plugins.js'

// Phase 7 — a read-only merged view of the global catalog + one conversation's workspace registry.
// Every existing plugin consumer (contextTools, pluginTools, introspection, the protocol handler)
// takes a RegistryView; passing this merge is how workspace plugins participate without changing
// those call sites. Rules: the GLOBAL registry wins id collisions (a workspace plugin whose id is
// already global surfaces as invalid, "shadowed"); workspace entries are tagged scope:'workspace'
// + workspaceKey so the renderer/protocol can address their assets.

export function mergeRegistry(
  global: RegistryView,
  workspace?: RegistryView,
  workspaceKey?: string
): RegistryView {
  const asWorkspace = (p: DiscoveredPlugin): DiscoveredPlugin => ({
    ...p,
    scope: 'workspace',
    workspaceKey
  })
  return {
    get: (id) => {
      const g = global.get(id)
      if (g) return { ...g, scope: 'global' }
      const w = workspace?.get(id)
      return w ? asWorkspace(w) : undefined
    },
    // Global wins, so its dir is authoritative for a shadowed id; else fall through to workspace.
    dirOf: (id) => global.dirOf(id) ?? workspace?.dirOf(id) ?? null,
    list: () => {
      const globals: DiscoveredPlugin[] = global.list().map((p) => ({ ...p, scope: 'global' }))
      const globalIds = new Set(globals.map((p) => p.id))
      const ws: DiscoveredPlugin[] = (workspace?.list() ?? []).map((p) =>
        globalIds.has(p.id)
          ? {
              id: p.id,
              dir: p.dir,
              valid: false,
              error: 'id shadowed by a global plugin',
              scope: 'workspace',
              workspaceKey
            }
          : asWorkspace(p)
      )
      return [...globals, ...ws]
    }
  }
}
