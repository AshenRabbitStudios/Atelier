import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FsEntry, FsListResult } from '../shared/events.js'

// A1 — cwd-scoped, NON-RECURSIVE directory listing for a plugin pane (permission `fs:list`). The
// read-only, name-only sibling of the `file:` DataBus source: it enumerates one directory level and
// tags each entry `ignored` (matched by the workspace `.gitignore` or a built-in default). The host
// bounds `dir` to the conversation cwd via the same resolver the write/read paths use (returns null
// → refused), so a plugin's filesystem reach never widens. Every failure is `{ error }` (never a
// throw across the relay). A correct-enough single-file `.gitignore` evaluation is fine for v1;
// nested/negated rules are a polish item (HOST-ADDENDUM A1).

export const MAX_ENTRIES = 5000

// Always-ignored (independent of .gitignore) so a pane never mistakes VCS/dep noise for content.
const BUILTIN_IGNORES = new Set(['.git', 'node_modules'])

/** A tiny single-file `.gitignore` matcher: bare names + `*.ext` globs + trailing-slash dir rules.
 *  Nested/negated (`!`) rules are intentionally out of scope for v1. */
interface GitignoreMatcher {
  ignores(name: string, isDir: boolean): boolean
}

function loadGitignore(cwdRoot: string): GitignoreMatcher {
  let lines: string[] = []
  try {
    lines = readFileSync(join(cwdRoot, '.gitignore'), 'utf8').split(/\r?\n/)
  } catch {
    /* no .gitignore — only built-ins apply */
  }
  const exact = new Set<string>()
  const dirOnly = new Set<string>()
  const extGlobs: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    // Ignore rules with a path separator (they target nested paths we don't evaluate at v1).
    const body = line.replace(/^\//, '')
    if (body.includes('/') && !body.endsWith('/')) continue
    if (body.endsWith('/')) {
      dirOnly.add(body.slice(0, -1))
      continue
    }
    if (body.startsWith('*.')) {
      extGlobs.push(body.slice(1)) // ".ext"
      continue
    }
    exact.add(body)
  }
  return {
    ignores(name, isDir) {
      if (exact.has(name)) return true
      if (isDir && dirOnly.has(name)) return true
      for (const ext of extGlobs) if (name.endsWith(ext)) return true
      return false
    }
  }
}

/**
 * Build a lister that maps a plugin's (conversationId, relDir) to a bounded, non-recursive listing,
 * scoped by `resolvePath` (null refuses an out-of-bounds path — the same cwd resolver the file:
 * source uses) and `cwdRootFor` (the conversation's cwd, for locating `.gitignore`).
 */
export function createFsLister(
  resolvePath: (conversationId: string, rel: string) => string | null,
  cwdRootFor: (conversationId: string) => string | null
): (conversationId: string, dir?: string) => FsListResult {
  return (conversationId, dir = '') => {
    const abs = resolvePath(conversationId, dir)
    if (!abs) return { error: `path "${dir}" is outside the conversation folder` }
    const root = cwdRootFor(conversationId)
    const matcher = root ? loadGitignore(root) : { ignores: () => false }
    let names: string[]
    try {
      names = readdirSync(abs)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    const entries: FsEntry[] = []
    let truncated = false
    for (const name of names) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        break
      }
      let isDir = false
      let size: number | undefined
      let mtime: number | undefined
      try {
        const st = statSync(join(abs, name))
        isDir = st.isDirectory()
        if (!isDir) size = st.size
        mtime = st.mtimeMs
      } catch {
        // A dangling symlink or a race with a delete — surface the name, skip the metadata.
      }
      const ignored = BUILTIN_IGNORES.has(name) || matcher.ignores(name, isDir)
      entries.push({ name, kind: isDir ? 'dir' : 'file', size, mtime, ignored })
    }
    return truncated ? { entries, truncated } : { entries }
  }
}
