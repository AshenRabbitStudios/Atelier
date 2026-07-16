import { useEffect, useRef } from 'react'
import { URL_CHANNEL_PREFIX } from '@shared/plugins'
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
          return reply(d.id, false, undefined, `unknown data method "${d.method}"`)
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
    }
  }, [pluginId, permissions, getConversationId, onDock, onSetTitle])

  return (
    <iframe
      ref={frameRef}
      className="plugin-frame"
      src={`atelier-plugin://${pluginId}/`}
      sandbox="allow-scripts"
      title={pluginId}
    />
  )
}
