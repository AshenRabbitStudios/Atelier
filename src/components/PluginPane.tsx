import { useEffect, useRef } from 'react'
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

    const onMessage = async (e: MessageEvent): Promise<void> => {
      if (e.source !== frame.contentWindow) return // only this plugin's own frame
      const d = e.data as RpcMessage
      if (!d || d.__atelier !== true || d.pluginId !== pluginId) return
      const args = d.args ?? []
      try {
        if (d.ns === 'lifecycle' && d.method === 'ready') {
          // The frame is live — fire its 'load' hook so it can rebuild from storage.
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
        reply(d.id, false, undefined, `unknown namespace "${d.ns}"`)
      } catch (err) {
        reply(d.id, false, undefined, err instanceof Error ? err.message : String(err))
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
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
