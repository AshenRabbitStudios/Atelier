import { useEffect, useRef } from 'react'
import { URL_CHANNEL_PREFIX } from '@shared/plugins'
import { composeInto } from '../services/composerRegistry'
import {
  BROWSER_READ_SCRIPT,
  browserExecScript,
  browserClickScript,
  browserFillScript
} from '@shared/browserRead'
import type { DockPosition } from '@shared/plugins'

// Host side of one mounted plugin: a sandboxed iframe loaded over atelier-plugin://, plus the
// postMessage relay that mediates every host call. The plugin (opaque origin, allow-scripts only)
// can reach the app ONLY through these messages; we permission-check and forward to main over IPC.
interface Props {
  pluginId: string
  // The asset host for the iframe: the bare id for a global plugin, or the encoded
  // `w--<key>--<id>` for a workspace plugin (Phase 7). The runtime decodes it back to the bare
  // pluginId, so RPC/permission/relay keying stays on `pluginId`.
  host: string
  permissions: string[]
  getConversationId: () => string | null
  onDock: (position: DockPosition) => void
  onSetTitle: (title: string) => void
}

interface RpcMessage {
  __atelier?: boolean
  id?: string
  pluginId?: string
  ns?: string
  method?: string
  args?: unknown[]
}

// The subset of Electron's <webview> element the browser surface uses. Typed locally so the
// renderer keeps zero imports from 'electron' (architecture invariant: renderer talks IPC only).
interface WebviewEl extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
  getURL(): string
  executeJavaScript(code: string): Promise<unknown>
}

// Theme tokens pushed into the plugin frame so its body can read as native (DESIGN_SYSTEM.md §4).
const THEME_TOKENS = [
  '--bg',
  '--bg-2',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--input',
  '--border',
  '--border-2',
  '--text',
  '--dim',
  '--faint',
  '--accent',
  '--accent-2',
  '--accent-weak',
  '--on-accent',
  '--ok',
  '--warn',
  '--err',
  '--font',
  '--mono'
]

export function PluginPane({
  pluginId,
  host,
  permissions,
  getConversationId,
  onDock,
  onSetTitle
}: Props): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // The relay effect keys on `pluginId` ALONE and reads everything else through refs. The other
  // props (`permissions` array, three closures) get fresh identities on every App render (the 10s
  // usage poll re-renders it), and the old effect depended on them — so each re-render tore the
  // effect down and rebuilt it, which UNSUBSCRIBED every DataBus channel (the frame never
  // re-subscribes) and DESTROYED the browser webview. Refs keep the values live without
  // re-running the effect (ARCH_REVIEW_2026-07-19 P0 #4).
  const permissionsRef = useRef(permissions)
  permissionsRef.current = permissions
  const getConversationIdRef = useRef(getConversationId)
  getConversationIdRef.current = getConversationId
  const onDockRef = useRef(onDock)
  onDockRef.current = onDock
  const onSetTitleRef = useRef(onSetTitle)
  onSetTitleRef.current = onSetTitle

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const perms = (): string[] => permissionsRef.current
    const getConversationId = (): string | null => getConversationIdRef.current()

    const reply = (id: string | undefined, ok: boolean, result?: unknown, error?: string): void => {
      if (!id) return
      frame.contentWindow?.postMessage({ __atelierReply: true, id, ok, result, error }, '*')
    }

    // Push the active theme's token values into the (cross-origin) plugin frame so its body can
    // use var(--…) and read native. Re-pushed on theme/density change (App dispatches 'atelier-theme').
    const pushTheme = (): void => {
      const cs = getComputedStyle(document.documentElement)
      const tokens: Record<string, string> = {}
      for (const name of THEME_TOKENS) tokens[name] = cs.getPropertyValue(name).trim()
      frame.contentWindow?.postMessage(
        { __atelierEvent: true, event: 'theme', payload: tokens },
        '*'
      )
    }
    window.addEventListener('atelier-theme', pushTheme)

    // The agent rewrote one of this plugin's pinned context exports (main pushes context:changed).
    // Forward it into the frame as a 'context' event so the pane refreshes that key — replacing the
    // per-plugin polling loops. Filtered to this pane's plugin and its active conversation.
    const offContext = window.atelier.plugins.onContextChanged((evt) => {
      if (evt.pluginId !== pluginId || evt.conversationId !== getConversationId()) return
      frame.contentWindow?.postMessage(
        { __atelierEvent: true, event: 'context', payload: { key: evt.key } },
        '*'
      )
    })

    // DataBus: a value arrived on a channel this plugin subscribes to (main routes it to us by
    // pluginId). Forward it into the frame; the runtime dispatches to that channel's callbacks.
    const offData = window.atelier.plugins.onDataMessage((evt) => {
      if (evt.pluginId !== pluginId || evt.conversationId !== getConversationId()) return
      frame.contentWindow?.postMessage(
        { __atelierEvent: true, event: 'data', payload: { channel: evt.channel, data: evt.data } },
        '*'
      )
    })

    // A4 — OS events (notification click / window focus). A notification-click is routed to the
    // owning plugin (main tags it with pluginId); a window-focus event carries no plugin, so we only
    // forward it once this pane opted in via os.onWindowFocusChange. Both become an 'os' frame event.
    let wantsFocusEvents = false
    const offOsEvent = window.atelier.plugins.onOsEvent((evt) => {
      if (evt.kind === 'notification-click') {
        if (evt.pluginId !== pluginId) return
      } else if (evt.kind === 'window-focus') {
        if (!wantsFocusEvents) return
      }
      frame.contentWindow?.postMessage({ __atelierEvent: true, event: 'os', payload: evt }, '*')
    })

    // Channels this pane subscribed to (channel -> the conversation it was scoped to), so we can
    // release them in cleanup even after the active conversation has changed.
    const subscribedChannels = new Map<string, string>()

    // Agent-event forwarding is opt-in (agent.onEvent): subscribe lazily on first request so a
    // pane that never asks isn't firehosed; torn down in cleanup.
    let offAgentEvents: (() => void) | null = null

    // Report this pane's size to the frame (layout.onResize). ResizeObserver already coalesces.
    const resizeObserver = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (!r) return
      frame.contentWindow?.postMessage(
        {
          __atelierEvent: true,
          event: 'resize',
          payload: { w: Math.round(r.width), h: Math.round(r.height) }
        },
        '*'
      )
    })
    if (wrapRef.current) resizeObserver.observe(wrapRef.current)

    // ---- Host-owned browser surface (permission "browser:embed") ----
    // A real Chromium <webview>, DOM-composited over this pane (so docking/hiding/resize come for
    // free) and driven ONLY via RPC. The guest page runs in its own process with zero privileges
    // (main hardens every attach) and has no path to the atelier bridge. Created lazily on the
    // first open(); requires webviewTag, which is enabled at window creation.
    let webview: WebviewEl | null = null
    let webviewReady = false
    let pendingBounds: { x: number; y: number; w: number; h: number } | null = null

    const applyBounds = (el: WebviewEl): void => {
      if (!pendingBounds) return
      el.style.left = `${pendingBounds.x}px`
      el.style.top = `${pendingBounds.y}px`
      el.style.width = `${pendingBounds.w}px`
      el.style.height = `${pendingBounds.h}px`
    }

    const pushBrowserEvent = (payload: Record<string, unknown>): void => {
      const nav =
        webview && webviewReady
          ? { canGoBack: webview.canGoBack(), canGoForward: webview.canGoForward() }
          : { canGoBack: false, canGoForward: false }
      frame.contentWindow?.postMessage(
        { __atelierEvent: true, event: 'browser', payload: { ...payload, ...nav } },
        '*'
      )
    }

    const ensureWebview = (url: string): WebviewEl => {
      if (webview) return webview
      const wrap = wrapRef.current
      if (!wrap) throw new Error('pane container not mounted')
      const el = document.createElement('webview') as WebviewEl
      if (typeof el.loadURL !== 'function') {
        el.remove()
        throw new Error('browser surface unavailable — restart Atelier to enable webview support')
      }
      el.className = 'plugin-webview'
      // Cookies/session persist per plugin, never shared with the app session.
      el.setAttribute('partition', `persist:atelier-browser:${pluginId}`)
      // Without allowpopups, window.open is blocked BEFORE main's setWindowOpenHandler — _blank
      // links would silently do nothing. With it, the handler denies the OS window and navigates
      // in place instead (verified by scripts/verify-webview.mjs).
      el.setAttribute('allowpopups', '')
      el.setAttribute('src', url)
      el.addEventListener('dom-ready', () => {
        webviewReady = true
      })
      el.addEventListener('did-start-loading', () => pushBrowserEvent({ type: 'loading' }))
      el.addEventListener('did-stop-loading', () =>
        pushBrowserEvent({ type: 'loaded', url: webviewReady ? el.getURL() : url })
      )
      el.addEventListener('did-fail-load', (e) => {
        const f = e as unknown as {
          isMainFrame?: boolean
          errorDescription?: string
          validatedURL?: string
        }
        if (f.isMainFrame === false) return
        pushBrowserEvent({
          type: 'failed',
          url: f.validatedURL,
          error: f.errorDescription || 'load failed'
        })
      })
      const onNav = (e: Event): void => {
        const n = e as unknown as { url?: string }
        pushBrowserEvent({ type: 'nav', url: n.url })
      }
      el.addEventListener('did-navigate', onNav)
      el.addEventListener('did-navigate-in-page', onNav)
      el.addEventListener('page-title-updated', (e) => {
        const t = e as unknown as { title?: string }
        pushBrowserEvent({ type: 'title', title: t.title })
      })
      applyBounds(el)
      wrap.appendChild(el)
      webview = el
      return el
    }

    const onMessage = async (e: MessageEvent): Promise<void> => {
      if (e.source !== frame.contentWindow) return // only this plugin's own frame
      const d = e.data as RpcMessage
      if (!d || d.__atelier !== true || d.pluginId !== pluginId) return
      const args = d.args ?? []
      try {
        if (d.ns === 'lifecycle' && d.method === 'ready') {
          // The frame is live — send the theme tokens, then fire its 'load' hook.
          pushTheme()
          frame.contentWindow?.postMessage({ __atelierEvent: true, event: 'load' }, '*')
          return
        }
        if (d.ns === 'storage') {
          if (!perms().includes('storage')) {
            return reply(d.id, false, undefined, 'permission "storage" not granted')
          }
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'get') {
            return reply(
              d.id,
              true,
              await window.atelier.plugins.storageGet(conv, pluginId, String(args[0]))
            )
          }
          if (d.method === 'set') {
            await window.atelier.plugins.storageSet(conv, pluginId, String(args[0]), args[1])
            return reply(d.id, true)
          }
          if (d.method === 'keys') {
            return reply(d.id, true, await window.atelier.plugins.storageKeys(conv, pluginId))
          }
          return reply(d.id, false, undefined, `unknown storage method "${d.method}"`)
        }
        if (d.ns === 'layout') {
          if (d.method === 'dock') {
            onDockRef.current(args[0] as DockPosition)
            return reply(d.id, true)
          }
          if (d.method === 'setTitle') {
            onSetTitleRef.current(String(args[0]))
            return reply(d.id, true)
          }
          return reply(d.id, false, undefined, `unknown layout method "${d.method}"`)
        }
        if (d.ns === 'context') {
          if (!perms().includes('context')) {
            return reply(d.id, false, undefined, 'permission "context" not granted')
          }
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'get') {
            return reply(
              d.id,
              true,
              await window.atelier.plugins.contextGet(conv, pluginId, String(args[0]))
            )
          }
          if (d.method === 'set') {
            await window.atelier.plugins.contextSet(
              conv,
              pluginId,
              String(args[0]),
              String(args[1])
            )
            return reply(d.id, true)
          }
          return reply(d.id, false, undefined, `unknown context method "${d.method}"`)
        }
        if (d.ns === 'data') {
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'subscribe' || d.method === 'unsubscribe') {
            if (!perms().includes('data:subscribe')) {
              return reply(d.id, false, undefined, 'permission "data:subscribe" not granted')
            }
            const channel = String(args[0])
            // Network reach is its own capability class: `data:subscribe` alone grants only
            // conversation-scoped sources (files, bash taps), not host-side URL fetches.
            if (channel.startsWith(URL_CHANNEL_PREFIX) && !perms().includes('net:fetch')) {
              return reply(d.id, false, undefined, 'permission "net:fetch" not granted')
            }
            if (d.method === 'subscribe') {
              await window.atelier.plugins.dataSubscribe(conv, pluginId, channel)
              subscribedChannels.set(channel, conv)
            } else {
              subscribedChannels.delete(channel)
              await window.atelier.plugins.dataUnsubscribe(conv, pluginId, channel)
            }
            return reply(d.id, true)
          }
          if (d.method === 'publish') {
            if (!perms().includes('data:publish')) {
              return reply(d.id, false, undefined, 'permission "data:publish" not granted')
            }
            await window.atelier.plugins.dataPublish(conv, pluginId, String(args[0]), args[1])
            return reply(d.id, true)
          }
          if (d.method === 'readAsset') {
            // A cwd file read, like the file: source — gated by the same capability.
            if (!perms().includes('data:subscribe')) {
              return reply(d.id, false, undefined, 'permission "data:subscribe" not granted')
            }
            const result = await window.atelier.plugins.readAsset(conv, pluginId, String(args[0]))
            return reply(d.id, true, result)
          }
          if (d.method === 'history') {
            if (!perms().includes('data:subscribe')) {
              return reply(d.id, false, undefined, 'permission "data:subscribe" not granted')
            }
            const channel = String(args[0])
            if (channel.startsWith(URL_CHANNEL_PREFIX) && !perms().includes('net:fetch')) {
              return reply(d.id, false, undefined, 'permission "net:fetch" not granted')
            }
            const limit = typeof args[1] === 'number' ? args[1] : undefined
            return reply(
              d.id,
              true,
              await window.atelier.plugins.dataHistory(conv, pluginId, channel, limit)
            )
          }
          if (d.method === 'writeFile') {
            if (!perms().includes('data:write')) {
              return reply(d.id, false, undefined, 'permission "data:write" not granted')
            }
            const result = await window.atelier.plugins.writeFile(
              conv,
              pluginId,
              String(args[0]),
              String(args[1] ?? '')
            )
            return reply(d.id, true, result)
          }
          return reply(d.id, false, undefined, `unknown data method "${d.method}"`)
        }
        if (d.ns === 'net') {
          if (!perms().includes('net:fetch')) {
            return reply(d.id, false, undefined, 'permission "net:fetch" not granted')
          }
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'fetch') {
            const result = await window.atelier.plugins.netFetch(
              conv,
              pluginId,
              String(args[0] ?? ''),
              (args[1] ?? {}) as Parameters<typeof window.atelier.plugins.netFetch>[3]
            )
            return reply(d.id, true, result)
          }
          return reply(d.id, false, undefined, `unknown net method "${d.method}"`)
        }
        if (d.ns === 'agent') {
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'info') {
            if (!perms().includes('agent:read')) {
              return reply(d.id, false, undefined, 'permission "agent:read" not granted')
            }
            const list = await window.atelier.agent.list()
            const me = list.find((c) => c.id === conv)
            return reply(
              d.id,
              true,
              me ? { id: me.id, title: me.title, cwd: me.cwd, status: me.status } : null
            )
          }
          if (d.method === 'events') {
            if (!perms().includes('agent:read')) {
              return reply(d.id, false, undefined, 'permission "agent:read" not granted')
            }
            // Forward only THIS conversation's events (checked live, so a conversation switch
            // re-scopes without re-subscribing). Subscribe once, on first request.
            if (!offAgentEvents) {
              offAgentEvents = window.atelier.agent.onEvent((ev) => {
                if (ev.instanceId !== getConversationId()) return
                frame.contentWindow?.postMessage(
                  { __atelierEvent: true, event: 'agent', payload: ev },
                  '*'
                )
              })
            }
            return reply(d.id, true)
          }
          if (d.method === 'send') {
            if (!perms().includes('agent:send')) {
              return reply(d.id, false, undefined, 'permission "agent:send" not granted')
            }
            await window.atelier.agent.send(conv, String(args[0] ?? ''))
            return reply(d.id, true)
          }
          if (d.method === 'compose') {
            // A3 — stage text into THIS conversation's composer without sending. Renderer-local:
            // there is no host round-trip; the composer registry inserts at the cursor. The 4KB cap
            // keeps a runaway pane from flooding the input. `{ error }` when the composer isn't mounted.
            if (!perms().includes('agent:compose')) {
              return reply(d.id, false, undefined, 'permission "agent:compose" not granted')
            }
            const text = String(args[0] ?? '').slice(0, 4096)
            const ok = composeInto(conv, text)
            return reply(d.id, true, ok ? { ok: true } : { error: 'composer not open' })
          }
          if (d.method === 'history') {
            if (!perms().includes('agent:read')) {
              return reply(d.id, false, undefined, 'permission "agent:read" not granted')
            }
            const limit = typeof args[0] === 'number' ? args[0] : undefined
            return reply(
              d.id,
              true,
              await window.atelier.plugins.agentHistory(conv, pluginId, limit)
            )
          }
          return reply(d.id, false, undefined, `unknown agent method "${d.method}"`)
        }
        if (d.ns === 'fs') {
          if (!perms().includes('fs:list')) {
            return reply(d.id, false, undefined, 'permission "fs:list" not granted')
          }
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'list') {
            const dir = args[0] == null ? undefined : String(args[0])
            return reply(d.id, true, await window.atelier.plugins.fsList(conv, pluginId, dir))
          }
          return reply(d.id, false, undefined, `unknown fs method "${d.method}"`)
        }
        if (d.ns === 'shell') {
          if (!perms().includes('shell:open')) {
            return reply(d.id, false, undefined, 'permission "shell:open" not granted')
          }
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'openPath') {
            return reply(
              d.id,
              true,
              await window.atelier.plugins.shellOpen(conv, pluginId, String(args[0] ?? ''))
            )
          }
          return reply(d.id, false, undefined, `unknown shell method "${d.method}"`)
        }
        if (d.ns === 'os') {
          if (!perms().includes('os:notify')) {
            return reply(d.id, false, undefined, 'permission "os:notify" not granted')
          }
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'notify') {
            const n = (args[0] ?? {}) as {
              title?: string
              body?: string
              sound?: boolean
              tag?: string
            }
            return reply(
              d.id,
              true,
              await window.atelier.plugins.notify(conv, pluginId, {
                title: String(n.title ?? ''),
                body: String(n.body ?? ''),
                sound: n.sound,
                tag: n.tag
              })
            )
          }
          if (d.method === 'flashFrame') {
            await window.atelier.plugins.flashFrame(conv, pluginId, !!args[0])
            return reply(d.id, true)
          }
          if (d.method === 'setBadgeCount') {
            await window.atelier.plugins.setBadgeCount(conv, pluginId, Number(args[0]) || 0)
            return reply(d.id, true)
          }
          if (d.method === 'isWindowFocused') {
            return reply(d.id, true, await window.atelier.plugins.isWindowFocused(conv, pluginId))
          }
          if (d.method === 'subscribeFocus') {
            // The frame's os.onWindowFocusChange opted in — start forwarding focus events to it.
            wantsFocusEvents = true
            return reply(d.id, true)
          }
          return reply(d.id, false, undefined, `unknown os method "${d.method}"`)
        }
        if (d.ns === 'backend') {
          // A7 — panel→own-service-backend RPC. No permission gate here (the plugin can only reach
          // ITS OWN backend); main verifies the plugin declares a service backend and is enabled.
          const conv = getConversationId()
          if (!conv) return reply(d.id, false, undefined, 'no active conversation')
          if (d.method === 'call') {
            const op = String(args[0] ?? '')
            const timeoutMs = typeof args[2] === 'number' ? args[2] : undefined
            const res = await window.atelier.plugins.backendCall(
              conv,
              pluginId,
              op,
              args[1],
              timeoutMs
            )
            // Unwrap { result } to the raw value the pane asked for; surface { error } as a rejection.
            if ('error' in res) return reply(d.id, false, undefined, res.error)
            return reply(d.id, true, res.result)
          }
          return reply(d.id, false, undefined, `unknown backend method "${d.method}"`)
        }
        if (d.ns === 'browser') {
          if (!perms().includes('browser:embed')) {
            return reply(d.id, false, undefined, 'permission "browser:embed" not granted')
          }
          if (d.method === 'open') {
            const url = String(args[0] ?? '')
            if (!/^https?:\/\//i.test(url)) {
              return reply(d.id, false, undefined, 'browser.open takes an http(s) URL')
            }
            const el = ensureWebview(url) // throws (→ error reply) when webview is unavailable
            el.style.display = 'flex'
            if (webviewReady)
              el.loadURL(url).catch(() => {}) // rejection surfaces as did-fail-load
            else el.setAttribute('src', url)
            return reply(d.id, true)
          }
          if (d.method === 'close') {
            if (webview) {
              if (webviewReady) webview.stop()
              webview.style.display = 'none'
            }
            return reply(d.id, true)
          }
          if (d.method === 'setBounds') {
            const r = args[0] as { x?: number; y?: number; w?: number; h?: number } | undefined
            // Clamp to the pane's own rect so an oversized request can't force layout or (with a
            // future CSS change) paint past the clip. `overflow:hidden` on the wrap is the real
            // visual guard; this bounds the element itself (ARCH_REVIEW_2026-07-19 P0 #3).
            const wrap = wrapRef.current
            const maxW = wrap?.clientWidth ?? Number.MAX_SAFE_INTEGER
            const maxH = wrap?.clientHeight ?? Number.MAX_SAFE_INTEGER
            pendingBounds = {
              x: Math.max(0, Math.min(maxW, Number(r?.x) || 0)),
              y: Math.max(0, Math.min(maxH, Number(r?.y) || 0)),
              w: Math.max(0, Math.min(maxW, Number(r?.w) || 0)),
              h: Math.max(0, Math.min(maxH, Number(r?.h) || 0))
            }
            if (webview) applyBounds(webview)
            return reply(d.id, true)
          }
          if (
            d.method === 'back' ||
            d.method === 'forward' ||
            d.method === 'reload' ||
            d.method === 'stop'
          ) {
            if (!webview || !webviewReady) {
              return reply(d.id, false, undefined, 'no browser surface open')
            }
            if (d.method === 'back') webview.goBack()
            else if (d.method === 'forward') webview.goForward()
            else if (d.method === 'reload') webview.reload()
            else webview.stop()
            return reply(d.id, true)
          }
          if (d.method === 'read') {
            if (!webview || !webviewReady) {
              return reply(d.id, false, undefined, 'no browser surface open')
            }
            const opts = (args[0] ?? {}) as { includeHtml?: boolean }
            const page = (await webview.executeJavaScript(BROWSER_READ_SCRIPT)) as Record<
              string,
              unknown
            >
            if (opts.includeHtml === true) {
              const html = (await webview.executeJavaScript(
                'document.documentElement.outerHTML.slice(0, 8000)'
              )) as string
              page.html = html
            }
            page.canGoBack = webview.canGoBack()
            page.canGoForward = webview.canGoForward()
            return reply(d.id, true, page)
          }
          if (d.method === 'exec' || d.method === 'click' || d.method === 'fill') {
            if (!webview || !webviewReady) {
              return reply(d.id, false, undefined, 'no browser surface open')
            }
            // The page is untrusted: the script is built with JSON-embedded inputs and returns
            // { ok } | { error } DATA; we never treat its result as code (Phase 6).
            const script =
              d.method === 'exec'
                ? browserExecScript(String(args[0] ?? ''))
                : d.method === 'click'
                  ? browserClickScript(String(args[0] ?? ''))
                  : browserFillScript(String(args[0] ?? ''), String(args[1] ?? ''))
            const result = await webview.executeJavaScript(script)
            return reply(d.id, true, result)
          }
          return reply(d.id, false, undefined, `unknown browser method "${d.method}"`)
        }
        reply(d.id, false, undefined, `unknown namespace "${d.ns}"`)
      } catch (err) {
        reply(d.id, false, undefined, err instanceof Error ? err.message : String(err))
      }
    }

    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('atelier-theme', pushTheme)
      offContext()
      offData()
      offOsEvent()
      offAgentEvents?.()
      resizeObserver.disconnect()
      // Release this pane's channel subscriptions (pane unmount / conversation switch).
      for (const [channel, conv] of subscribedChannels) {
        void window.atelier.plugins.dataUnsubscribe(conv, pluginId, channel)
      }
      // Tear down the browser surface with its pane; the guest process dies with the element.
      webview?.remove()
      webview = null
    }
    // Keyed on pluginId ONLY — all other inputs are read live through refs above, so a parent
    // re-render can't tear down the relay/subscriptions/webview (P0 #4).
  }, [pluginId])

  return (
    <div ref={wrapRef} className="plugin-pane-wrap">
      <iframe
        ref={frameRef}
        className="plugin-frame"
        src={`atelier-plugin://${host}/`}
        // allow-same-origin grants the frame its OWN origin (atelier-plugin://<id>) — cross-origin
        // to the renderer AND to every other plugin, so it gains ES modules, fetch() of its own
        // assets, IndexedDB, and workers WITHOUT any reach into the app or other panes. window.atelier
        // stays postMessage-only (Phase 2 / docs/roadmap/02-same-origin-panes.md).
        sandbox="allow-scripts allow-same-origin"
        title={pluginId}
      />
    </div>
  )
}
