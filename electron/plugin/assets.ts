import { readFile, stat } from 'node:fs/promises'

// Read-only, cwd-scoped BINARY asset reads for a plugin pane — the subresource analog of the
// DataBus file: text channel. A sandboxed pane renders content in-document under its own origin
// (atelier-plugin://<id>/), so an <img>/<embed> with a relative/local src resolves against the
// plugin folder and 404s; and a raw subresource GET carries no conversation id, so the host can't
// scope it. Instead the pane asks the host (over the mediated bridge, which knows the conversation)
// to read a referenced asset and hands back a bounded data: URL it can swap in.
//
// Same cwd-scoping and same capability gate (data:subscribe) as reading a text file via the file:
// source. Any type is allowed (images, pdf, audio/video, text) up to a size cap — the image-only
// restriction was an anti-exfiltration guard that is obsolete under the corrected framing (a pane
// can already read any text via file: channels; DECISIONS 2026-07-19).

export const MAX_ASSET_BYTES = 10_000_000

const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv'
}

export type AssetResult = { dataUrl: string } | { error: string }

const extOf = (p: string): string => {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i).toLowerCase()
}

/**
 * Build a reader that maps a plugin's (conversationId, relPath) to a data: URL, scoped within the
 * conversation cwd by `resolvePath` (the same resolver the file: source uses; returns null to
 * refuse an out-of-bounds path). Only image types, only up to MAX_ASSET_BYTES; every failure is an
 * `{ error }` (never a throw) so the caller can annotate a broken image rather than crash.
 */
export function createAssetReader(
  resolvePath: (conversationId: string, rel: string) => string | null
): (conversationId: string, rel: string) => Promise<AssetResult> {
  return async (conversationId, rel) => {
    const mime = ASSET_MIME[extOf(rel)] ?? 'application/octet-stream'
    const abs = resolvePath(conversationId, rel)
    if (!abs) return { error: `asset "${rel}" is outside the conversation folder` }
    try {
      const info = await stat(abs)
      if (info.size > MAX_ASSET_BYTES) {
        return { error: `asset "${rel}" too large (${info.size} bytes > ${MAX_ASSET_BYTES})` }
      }
      const bytes = await readFile(abs)
      return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
}
