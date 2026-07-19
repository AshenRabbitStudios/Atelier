import { useEffect, useRef } from 'react'
import { URL_CHANNEL_PREFIX } from '@shared/plugins'
import { BROWSER_READ_SCRIPT } from '@shared/browserRead'
import type { DockPosition } from '@shared/plugins'

// Host side of one mounted plugin: a sandboxed iframe loaded over atelier-plugin://, plus the
// postMessage relay that mediates every host call. The plugin (opaque origin, allow-scripts only)
// can reach the app ONLY through these messages; we permission-check and forward to main over IPC.
interface Props {
  pluginId: string
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
  permissions,
  getConversationId,
  onDock,
  onSetTitle
}: Props): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

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

    // Channels this pane subscribed to (channel -> the conversation it was scoped to), so we can
    // release them in cleanup even after the active conversation has changed.
    const subscribedChannels = new Map<string, string>()

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
          if (!permissions.includes('storage')) {
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
            onDock(args[0] as DockPosition)
            return reply(d.id, true)
          }
          if (d.method === 'setTitle') {
            onSetTitle(String(args[0]))
            return reply(d.id, true)
          }
          return reply(d.id, false, undefined, `unknown layout method "${d.method}"`)
        }
        if (d.ns === 'context') {
          if (!permissions.includes('context')) {
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
            if (!permissions.includes('data:subscribe')) {
              return reply(d.id, false, undefined, 'permission "data:subscribe" not granted')
            }
            const channel = String(args[0])
            // Network reach is its own capability class: `data:subscribe` alone grants only
            // conversation-scoped sources (files, bash taps), not host-side URL fetches.
            if (channel.startsWith(URL_CHANNEL_PREFIX) && !permissions.includes('net:fetch')) {
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
            if (!permissions.includes('data:publish')) {
              return reply(d.id, false, undefined, 'permission "data:publish" not granted')
            }
            await window.atelier.plugins.dataPublish(conv, pluginId, String(args[0]), args[1])
            return reply(d.id, true)
          }
          if (d.method === 'readAsset') {
            // A cwd file read, like the file: source — gated by the same capability.
            if (!permissions.includes('data:subscribe')) {
              return reply(d.id, false, undefined, 'permission "data:subscribe" not granted')
            }
            const result = await window.atelier.plugins.readAsset(conv, pluginId, String(args[0]))
            return reply(d.id, true, result)
          }
          return reply(d.id, false, undefined, `unknown data method "${d.method}"`)
        }
        if (d.ns === 'browser') {
          if (!permissions.includes('browser:embed')) {
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
            pendingBounds = {
              x: Math.max(0, Number(r?.x) || 0),
              y: Math.max(0, Number(r?.y) || 0),
              w: Math.max(0, Number(r?.w) || 0),
              h: Math.max(0, Number(r?.h) || 0)
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
      // Release this pane's channel subscriptions (pane unmount / conversation switch).
      for (const [channel, conv] of subscribedChannels) {
        void window.atelier.plugins.dataUnsubscribe(conv, pluginId, channel)
      }
      // Tear down the browser surface with its pane; the guest process dies with the element.
      webview?.remove()
      webview = null
    }
  }, [pluginId, permissions, getConversationId, onDock, onSetTitle])

  return (
    <div ref={wrapRef} className="plugin-pane-wrap">
      <iframe
        ref={frameRef}
        className="plugin-frame"
        src={`atelier-plugin://${pluginId}/`}
        sandbox="allow-scripts"
        title={pluginId}
      />
    </div>
  )
}
