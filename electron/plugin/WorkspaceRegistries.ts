import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { WORKSPACE_KEY_LEN, type RegistryView } from '../shared/plugins.js'

// Phase 7 — workspace-local plugins (docs/roadmap/07-workspace-plugins.md). A plugin authored under
// a conversation's `<cwd>/.atelier/plugins` is discovered by a SECOND registry instance scoped to
// that cwd (never by threading conversation-scope through the pervasive global registry). This class
// owns one workspace `PluginRegistry` per distinct open cwd, refcounted by the conversations on it:
// created when the first conversation on a cwd opens, stopped (fs watcher released) when the last
// closes. It also indexes registries by a stable cwd hash (the asset-host key) and emits a
// valid-id diff on every rescan so main can auto-enable a freshly-authored plugin (D2).

/** The minimal registry surface this manager drives; `PluginRegistry` satisfies it. */
export interface WorkspaceRegistry extends RegistryView {
  start(): void
  stop(): void
}

/** Builds a workspace registry rooted at `root`, calling `onChange` on every (debounced) rescan. */
export type MakeRegistry = (root: string, onChange: () => void) => WorkspaceRegistry

/** cwd → a stable, hostname-safe key (fixed-length lowercase hex) for the asset-host encoding. */
export function workspaceKeyForCwd(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, WORKSPACE_KEY_LEN)
}

/** What `onChange` reports after a workspace rescan: the newly-valid / newly-gone plugin ids and the
 *  conversations that share the cwd (so main can auto-enable an added plugin for exactly them). */
export interface WorkspaceChange {
  cwd: string
  convs: string[]
  added: string[]
  removed: string[]
}

interface Entry {
  cwd: string
  key: string
  registry: WorkspaceRegistry
  convs: Set<string>
  validIds: Set<string>
}

export class WorkspaceRegistries {
  private byCwd = new Map<string, Entry>()
  private byKey = new Map<string, string>() // key -> cwd
  private convCwd = new Map<string, string>() // conversationId -> cwd

  constructor(
    private make: MakeRegistry,
    private onChange: (change: WorkspaceChange) => void,
    private hash: (cwd: string) => string = workspaceKeyForCwd
  ) {}

  /** Reconcile tracked conversations to exactly `open`: acquire the new, release the gone. Called
   *  whenever the agent open-set changes (create/open/close/delete/restore). */
  reconcile(open: { id: string; cwd: string }[]): void {
    const want = new Map(open.map((o) => [o.id, o.cwd]))
    for (const id of [...this.convCwd.keys()]) if (!want.has(id)) this.release(id)
    for (const [id, cwd] of want) this.acquire(id, cwd)
  }

  /** Track a conversation on `cwd`, creating (and starting) the cwd's registry on the first one. */
  acquire(conversationId: string, cwd: string): void {
    const prev = this.convCwd.get(conversationId)
    if (prev === cwd) return
    if (prev) this.release(conversationId)
    let entry = this.byCwd.get(cwd)
    if (!entry) {
      const key = this.hash(cwd)
      const registry = this.make(join(cwd, '.atelier', 'plugins'), () => this.handleChange(cwd))
      entry = { cwd, key, registry, convs: new Set(), validIds: new Set() }
      this.byCwd.set(cwd, entry)
      this.byKey.set(key, cwd)
      registry.start()
      entry.validIds = this.validIdSet(registry)
    }
    entry.convs.add(conversationId)
    this.convCwd.set(conversationId, cwd)
  }

  /** Drop a conversation; stop + forget the cwd's registry when it was the last one. */
  release(conversationId: string): void {
    const cwd = this.convCwd.get(conversationId)
    if (!cwd) return
    this.convCwd.delete(conversationId)
    const entry = this.byCwd.get(cwd)
    if (!entry) return
    entry.convs.delete(conversationId)
    if (entry.convs.size === 0) {
      entry.registry.stop()
      this.byCwd.delete(cwd)
      this.byKey.delete(entry.key)
    }
  }

  registryForCwd(cwd: string): WorkspaceRegistry | undefined {
    return this.byCwd.get(cwd)?.registry
  }

  registryForKey(key: string): WorkspaceRegistry | undefined {
    const cwd = this.byKey.get(key)
    return cwd ? this.byCwd.get(cwd)?.registry : undefined
  }

  keyForCwd(cwd: string): string | undefined {
    return this.byCwd.get(cwd)?.key
  }

  convsForCwd(cwd: string): string[] {
    return [...(this.byCwd.get(cwd)?.convs ?? [])]
  }

  stopAll(): void {
    for (const e of this.byCwd.values()) e.registry.stop()
    this.byCwd.clear()
    this.byKey.clear()
    this.convCwd.clear()
  }

  private validIdSet(registry: WorkspaceRegistry): Set<string> {
    return new Set(
      registry
        .list()
        .filter((p) => p.valid)
        .map((p) => p.id)
    )
  }

  private handleChange(cwd: string): void {
    const entry = this.byCwd.get(cwd)
    if (!entry) return
    const now = this.validIdSet(entry.registry)
    const added = [...now].filter((id) => !entry.validIds.has(id))
    const removed = [...entry.validIds].filter((id) => !now.has(id))
    entry.validIds = now
    this.onChange({ cwd, convs: [...entry.convs], added, removed })
  }
}
