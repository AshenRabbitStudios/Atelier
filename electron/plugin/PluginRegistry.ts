import { readFileSync, readdirSync, statSync, existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { ManifestSchema, type DiscoveredPlugin } from '../shared/plugins.js'

// App-wide plugin discovery (PLUGIN_ARCHITECTURE.md §1). Scans /plugins for folders containing a
// manifest.json — at the top level or one level down (so /plugins/examples/<id> is found) — and
// validates each manifest. A broken manifest yields an invalid DiscoveredPlugin (surfaced in the
// rail) rather than throwing. Watches the tree and re-scans (debounced) on change.
//
// Enablement is per-conversation and lives elsewhere (the conversation manifest); this registry is
// purely the global catalog.
export class PluginRegistry {
  private plugins = new Map<string, DiscoveredPlugin>()
  private watcher: FSWatcher | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null

  constructor(
    private root: string,
    private onChange?: (plugins: DiscoveredPlugin[]) => void
  ) {}

  /** Discover now and begin watching. Safe to call when `root` does not exist yet. */
  start(): void {
    this.scan()
    if (existsSync(this.root) && !this.watcher) {
      try {
        this.watcher = watch(this.root, { recursive: true }, () => this.scheduleRescan())
      } catch {
        /* watching is best-effort; discovery on start still works */
      }
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
  }

  list(): DiscoveredPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  dirOf(id: string): string | null {
    return this.plugins.get(id)?.dir ?? null
  }

  get(id: string): DiscoveredPlugin | undefined {
    return this.plugins.get(id)
  }

  private scheduleRescan(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.scan()
      this.onChange?.(this.list())
    }, 150)
  }

  /** Re-read the whole tree. Idempotent; replaces the in-memory catalog. */
  scan(): void {
    const found = new Map<string, DiscoveredPlugin>()
    for (const dir of this.candidateDirs()) {
      const p = this.read(dir)
      if (!p) continue
      // First definition of an id wins; a duplicate folder name is reported as invalid.
      if (found.has(p.id)) {
        found.set(p.id, { id: p.id, dir, valid: false, error: `duplicate plugin id "${p.id}"` })
      } else {
        found.set(p.id, p)
      }
    }
    this.plugins = found
  }

  /** Folders that contain a manifest.json, at depth 1 or 2 under root. */
  private candidateDirs(): string[] {
    const out: string[] = []
    const entries = this.safeReaddir(this.root)
    for (const name of entries) {
      const dir = join(this.root, name)
      if (!this.isDir(dir)) continue
      if (existsSync(join(dir, 'manifest.json'))) {
        out.push(dir)
        continue
      }
      // One level deeper (e.g. /plugins/examples/<id>).
      for (const sub of this.safeReaddir(dir)) {
        const subdir = join(dir, sub)
        if (this.isDir(subdir) && existsSync(join(subdir, 'manifest.json'))) out.push(subdir)
      }
    }
    return out
  }

  private read(dir: string): DiscoveredPlugin | null {
    const manifestPath = join(dir, 'manifest.json')
    const folderId = dir.split(/[\\/]/).pop() ?? dir
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      return {
        id: folderId,
        dir,
        valid: false,
        error: 'manifest.json is missing or not valid JSON'
      }
    }
    const parsed = ManifestSchema.safeParse(raw)
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
      return { id: folderId, dir, valid: false, error: msg }
    }
    const manifest = parsed.data
    if (manifest.id !== folderId) {
      return {
        id: folderId,
        dir,
        valid: false,
        error: `manifest.id "${manifest.id}" must match folder name "${folderId}"`
      }
    }
    if ((manifest.kind === 'panel' || manifest.kind === 'both') && !manifest.entry) {
      return { id: folderId, dir, valid: false, error: 'a panel plugin must declare "entry"' }
    }
    return { id: manifest.id, dir, valid: true, manifest }
  }

  private safeReaddir(dir: string): string[] {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }

  private isDir(p: string): boolean {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }
}
