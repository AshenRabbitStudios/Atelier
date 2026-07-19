import { protocol } from 'electron'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import type { PluginRegistry } from './PluginRegistry.js'
import { RUNTIME_JS } from './runtime.js'

// Serves plugin assets to sandboxed iframes over a custom scheme:
//   atelier-plugin://<pluginId>/<path>     → files from that plugin's folder (read-only)
//   atelier-plugin://__runtime__/atelier.js → the injected host runtime
// The scheme is registered as standard so iframes loaded from it get a stable opaque-ish origin
// and normal URL resolution. Path traversal outside a plugin's folder is refused.
export const PLUGIN_SCHEME = 'atelier-plugin'
const RUNTIME_HOST = '__runtime__'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

function contentType(p: string): string {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

/** Must run BEFORE app `ready` (Electron requirement for privileged schemes). */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/** Wire the handler. Call after app `ready`, once the registry exists. */
export function handlePluginProtocol(registry: PluginRegistry): void {
  protocol.handle(PLUGIN_SCHEME, (request) => {
    const url = new URL(request.url)
    const host = url.hostname

    if (host === RUNTIME_HOST) {
      return new Response(RUNTIME_JS, { headers: { 'content-type': 'text/javascript' } })
    }

    const dir = registry.dirOf(host)
    if (!dir) return new Response('plugin not found', { status: 404 })

    const manifest = registry.get(host)?.manifest
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (rel === '') rel = manifest?.entry ?? 'index.html'

    const base = resolve(dir)
    const full = resolve(join(base, rel))
    // Refuse anything that escapes the plugin's own folder.
    if (full !== base && !full.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))) {
      return new Response('forbidden', { status: 403 })
    }
    if (!existsSync(full)) return new Response('not found', { status: 404 })

    try {
      return new Response(readFileSync(full), { headers: { 'content-type': contentType(full) } })
    } catch {
      return new Response('read error', { status: 500 })
    }
  })
}
