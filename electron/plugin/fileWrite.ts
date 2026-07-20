import { writeFileAtomic } from '../atomicWrite.js'

// Cwd-scoped text file WRITES for a plugin pane (permission `data:write`) — the write sibling of the
// read-only `file:` DataBus source and `readAsset`. A pane produces an artifact (an editor's file, a
// generated report, an export) and asks the host to persist it; the host bounds it to the
// conversation cwd via the same resolver the read paths use (returns null → refused), so a plugin's
// filesystem reach never widens. Text/UTF-8 only, size-capped; every failure is `{ error }` (never a
// throw across the relay) so a confused pane annotates a failure instead of crashing.

export const MAX_WRITE_BYTES = 5_000_000

export type WriteResult = { ok: true } | { error: string }

/**
 * Build a writer that maps a plugin's (conversationId, relPath, content) to an atomic cwd-scoped
 * write, bounded by `resolvePath` (the same cwd resolver the file: source and readAsset use — null
 * refuses an out-of-bounds path). Parents are created; the write is atomic (temp + rename) so a
 * crash mid-write can't corrupt an existing file.
 */
export function createFileWriter(
  resolvePath: (conversationId: string, rel: string) => string | null
): (conversationId: string, rel: string, content: string) => Promise<WriteResult> {
  return async (conversationId, rel, content) => {
    if (typeof content !== 'string') return { error: 'content must be a string' }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) {
      return { error: `content too large (${bytes} bytes > ${MAX_WRITE_BYTES})` }
    }
    const abs = resolvePath(conversationId, rel)
    if (!abs) return { error: `path "${rel}" is outside the conversation folder` }
    try {
      writeFileAtomic(abs, content)
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
}
