// Host-side HTTP for a plugin pane (permission `net:fetch`) — a real request verb, beyond the
// one-shot GET-only `url:` DataBus channel. A sandboxed pane has no network of its own; this runs the
// request in main and returns the response as data, so a pane can call a local dev server's API, POST
// a webhook, or send an auth header. Bounded: http(s) only, method allow-list, capped body/response,
// cookie-isolated (never leaks main's session cookies in or out), and every failure is `{ error }`
// (never a throw across the relay). No streaming in v1 — a poller re-fetches.

export const NET_MAX_RESPONSE_BYTES = 4_000_000
export const NET_MAX_REQUEST_BYTES = 2_000_000
export const NET_DEFAULT_TIMEOUT_MS = 15_000
export const NET_MAX_TIMEOUT_MS = 60_000

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

export interface NetFetchOpts {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  binary?: boolean
}

export type NetFetchResult =
  | {
      status: number
      statusText: string
      headers: Record<string, string>
      bodyText?: string
      bodyBase64?: string
    }
  | { error: string }

/**
 * Build a host-side fetcher. `fetchImpl` is injectable so this is unit-testable without real network
 * (same approach as createUrlSource). Returns response data or `{ error }`; the caller's permission
 * (`net:fetch`) is enforced by the IPC handler, not here.
 */
export function createNetFetcher(
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): (url: string, opts?: NetFetchOpts) => Promise<NetFetchResult> {
  return async (url, opts = {}) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { error: `not a valid URL: ${url}` }
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { error: `must be http(s), got ${u.protocol}` }
    }
    const method = (opts.method ?? 'GET').toUpperCase()
    if (!METHODS.has(method)) return { error: `unsupported method "${method}"` }

    // Request headers: strings only; drop `cookie` so a pane can't ride the app/user session.
    const headers: Record<string, string> = {}
    if (opts.headers && typeof opts.headers === 'object') {
      for (const [k, v] of Object.entries(opts.headers)) {
        if (typeof v === 'string' && k.toLowerCase() !== 'cookie') headers[k] = v
      }
    }

    const hasBody = method !== 'GET' && method !== 'HEAD' && typeof opts.body === 'string'
    if (hasBody && Buffer.byteLength(opts.body as string, 'utf8') > NET_MAX_REQUEST_BYTES) {
      return { error: `request body too large (> ${NET_MAX_REQUEST_BYTES} bytes)` }
    }

    const timeout = Math.min(
      NET_MAX_TIMEOUT_MS,
      Math.max(1, opts.timeoutMs ?? NET_DEFAULT_TIMEOUT_MS)
    )
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetchImpl(u.href, {
        method,
        headers,
        body: hasBody ? (opts.body as string) : undefined,
        redirect: 'follow',
        signal: controller.signal
      })
      const outHeaders: Record<string, string> = {}
      res.headers.forEach((val, key) => {
        if (key.toLowerCase() !== 'set-cookie') outHeaders[key.toLowerCase()] = val
      })
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (declared > NET_MAX_RESPONSE_BYTES) {
        return { error: `response too large (${declared} bytes > ${NET_MAX_RESPONSE_BYTES})` }
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > NET_MAX_RESPONSE_BYTES) {
        return { error: `response too large (${buf.byteLength} bytes > ${NET_MAX_RESPONSE_BYTES})` }
      }
      const base = { status: res.status, statusText: res.statusText, headers: outHeaders }
      return opts.binary
        ? { ...base, bodyBase64: buf.toString('base64') }
        : { ...base, bodyText: buf.toString('utf8') }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }
}
