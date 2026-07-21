// Every shipped plugin manifest must validate against the live ManifestSchema — a broken
// manifest ships as an "invalid" rail entry, which is easy to miss headlessly. This scans
// the real /plugins tree (top level + examples/) so a new plugin is covered automatically.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManifestSchema } from './plugins.js'

const PLUGINS_ROOT = resolve(__dirname, '../../plugins')

function manifestDirs(root: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const dir = join(root, name.name)
    if (existsSync(join(dir, 'manifest.json'))) out.push(dir)
    else if (name.name === 'examples') out.push(...manifestDirs(dir))
  }
  return out
}

describe('shipped plugin manifests', () => {
  const dirs = manifestDirs(PLUGINS_ROOT)

  it('finds the plugin tree', () => {
    expect(dirs.length).toBeGreaterThan(0)
  })

  for (const dir of dirs) {
    it(`${dir.split(/[\\/]/).slice(-2).join('/')} is schema-valid`, () => {
      const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
      const res = ManifestSchema.safeParse(raw)
      if (!res.success) {
        throw new Error(res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      }
      // The id must match its folder name — the registry keys by folder.
      expect(res.data.id).toBe(dir.split(/[\\/]/).pop())
      // A declared backend must exist AND be .cjs: the repo's package.json says
      // "type":"module", so Node parses a .js backend as ESM and its require() throws
      // at spawn — an instant crash-loop that wedges the plugin (agent-flow shipped
      // this way and its git backend never ran; 2026-07-21).
      if (res.data.backend) {
        const backendPath = join(dir, res.data.backend)
        expect(existsSync(backendPath), `backend file missing: ${backendPath}`).toBe(true)
        expect(
          res.data.backend.endsWith('.cjs'),
          `${res.data.id}: backend "${res.data.backend}" must use the .cjs extension — ` +
            `a .js backend is parsed as ESM under the repo's "type":"module" and crashes on spawn`
        ).toBe(true)
      }
    })
  }
})
