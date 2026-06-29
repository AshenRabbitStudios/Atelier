import { useEffect, useRef, useState } from 'react'
import type { AgentInstance } from '@shared/events'
import { ChatPanel } from './ChatPanel'

/**
 * Hosts N agent instances (each rooted in its own folder) behind a selector.
 * Switching re-keys the ChatPanel so each instance gets a fresh transcript view.
 */
export function ClaudePanel({ initialInstanceId }: { initialInstanceId: string }) {
  const [instances, setInstances] = useState<AgentInstance[]>([])
  const [currentId, setCurrentId] = useState(initialInstanceId)
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  const refresh = async () => setInstances(await window.atelier.agent.list())
  useEffect(() => {
    void refresh()
  }, [])

  const current = instances.find((i) => i.id === currentId)

  const newInstance = async () => {
    const cwd = await window.atelier.app.pickFolder()
    if (!cwd) return
    const id = await window.atelier.agent.create({ cwd })
    await refresh()
    setCurrentId(id)
  }

  const openFolder = () => {
    if (current) void window.atelier.app.openPath(current.cwd)
  }

  const startRename = () => {
    setRenaming(current?.title ?? '')
    setTimeout(() => renameRef.current?.select(), 0)
  }
  const commitRename = async () => {
    const title = (renaming ?? '').trim()
    setRenaming(null)
    if (title && current && title !== current.title) {
      await window.atelier.agent.rename(currentId, title)
      await refresh()
    }
  }

  return (
    <div className="claude-panel">
      <div className="instance-bar">
        {renaming === null ? (
          <>
            <select
              className="instance-select"
              value={currentId}
              onChange={(e) => setCurrentId(e.target.value)}
              title="Which Claude you're talking to"
            >
              {instances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </select>
            <button className="icon-btn" title="Rename this Claude" onClick={startRename}>
              ✎
            </button>
          </>
        ) : (
          <input
            ref={renameRef}
            className="instance-rename"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              else if (e.key === 'Escape') setRenaming(null)
            }}
            placeholder="Name this Claude…"
          />
        )}

        <span className="instance-cwd" title={current?.cwd}>
          {current?.cwd ?? '—'}
        </span>
        <button className="icon-btn" title="Reveal folder in file manager" onClick={openFolder}>
          📂
        </button>
        <button className="icon-btn new-instance" title="New Claude on another folder" onClick={newInstance}>
          ＋ New
        </button>
      </div>

      <ChatPanel key={currentId} instanceId={currentId} />
    </div>
  )
}
