import { useEffect, useRef, useState } from 'react'
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import type {
  AgentInstance,
  ConversationSummary,
  SessionSummary,
  UsageInfo,
  UsageWindow
} from '@shared/events'
import { ChatPanel } from './components/ChatPanel'
import { LayoutService } from './services/LayoutService'

// The workspace renders the ACTIVE conversation's Claude pane. Conversation
// selection lives in the top bar, not inside the pane (SPEC §4.5).
const components = {
  claude: (props: IDockviewPanelProps<{ instanceId: string }>) => (
    <ChatPanel key={props.params.instanceId} instanceId={props.params.instanceId} />
  )
}

export function App() {
  const [open, setOpen] = useState<AgentInstance[]>([]) // open conversations (tabs)
  const [all, setAll] = useState<ConversationSummary[]>([]) // every conversation (dropdown)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState<{ cwd: string; sessions: SessionSummary[] } | null>(
    null
  )
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const layout = useRef<LayoutService | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const appliedRef = useRef<string | null>(null)
  const restoringRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Account-wide usage, polled every 10s off the active conversation (the manager
  // caches the last non-empty snapshot, so idle/just-restored sessions still report).
  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (!activeId) return
      try {
        const u = await window.atelier.agent.usage(activeId)
        if (alive && u.windows.length > 0) setUsage(u)
      } catch {
        /* usage unavailable */
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 10000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [activeId])

  const refresh = async () => {
    setOpen(await window.atelier.agent.list())
    setAll(await window.atelier.agent.listAll())
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        let list = await window.atelier.agent.list()
        if (list.length === 0) {
          const cwd = await window.atelier.app.defaultCwd()
          const id = await window.atelier.agent.create({ cwd })
          list = await window.atelier.agent.list()
          if (!alive) return
          setActiveId(id)
        } else {
          const active = await window.atelier.agent.activeId()
          if (!alive) return
          setActiveId(active && list.some((c) => c.id === active) ? active : list[0].id)
        }
        await refresh()
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Load the active conversation's saved dock layout (or default to just the Claude
  // pane). Each conversation owns its layout; switching swaps the whole workspace.
  const applyLayout = async (id: string) => {
    const ls = layout.current
    if (!ls) return
    if (appliedRef.current === id && ls.hasPanels()) return // already showing this one
    appliedRef.current = id
    restoringRef.current = true
    try {
      const saved = await window.atelier.agent.getLayout(id)
      if (saved) ls.restore(saved)
      else {
        ls.clear()
        ls.addClaude(id)
      }
    } catch {
      try {
        ls.clear()
        ls.addClaude(id)
      } catch {
        /* */
      }
    } finally {
      setTimeout(() => {
        restoringRef.current = false
      }, 0)
    }
  }

  useEffect(() => {
    activeIdRef.current = activeId
    if (!activeId) return
    void applyLayout(activeId)
    void window.atelier.agent.setActive(activeId)
  }, [activeId])

  const onReady = (event: DockviewReadyEvent) => {
    const ls = new LayoutService(event.api)
    layout.current = ls
    // Persist this conversation's layout on any dock change (debounced; ignore the
    // programmatic changes we make while restoring).
    ls.onLayoutChange(() => {
      if (restoringRef.current) return
      const id = activeIdRef.current
      if (!id) return
      const snapshot = ls.serialize() // capture now, not at fire time (survives a switch)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void window.atelier.agent.saveLayout(id, snapshot), 400)
    })
    if (activeId) void applyLayout(activeId)
  }

  const newConversation = async () => {
    const cwd = await window.atelier.app.pickFolder()
    if (!cwd) return
    const id = await window.atelier.agent.create({ cwd })
    await refresh()
    setActiveId(id)
  }

  const openConversation = async (id: string) => {
    await window.atelier.agent.open(id)
    await refresh()
    setActiveId(id)
  }

  const closeConversation = async (id: string) => {
    await window.atelier.agent.close(id)
    const remaining = await window.atelier.agent.list()
    setOpen(remaining)
    setAll(await window.atelier.agent.listAll())
    if (activeId === id) setActiveId(remaining[0]?.id ?? null)
  }

  const renameConversation = async (id: string, title: string) => {
    await window.atelier.agent.rename(id, title)
    await refresh()
  }

  const clearChat = async (id: string) => {
    if (
      !window.confirm('Clear the chat context for this conversation? This starts a fresh session.')
    )
      return
    await window.atelier.agent.clearChat(id)
    layout.current?.setClaudeInstance(id) // remount the pane → shows the empty transcript
  }

  const clearPlugins = async (id: string) => {
    if (!window.confirm('Clear all plugin data/state for this conversation?')) return
    await window.atelier.agent.clearPlugins(id)
  }

  const startImport = async () => {
    const cwd = await window.atelier.app.pickFolder()
    if (!cwd) return
    const sessions = await window.atelier.agent.sessionsFor(cwd)
    if (sessions.length === 0) {
      window.alert('No previous Claude sessions found in that folder.')
      return
    }
    setImporting({ cwd, sessions })
  }

  const doImport = async (sessionId: string, title: string) => {
    if (!importing) return
    const id = await window.atelier.agent.importSession(importing.cwd, sessionId, title)
    setImporting(null)
    await refresh()
    setActiveId(id)
  }

  const deleteConversation = async (id: string) => {
    if (
      !window.confirm(
        'Delete this conversation and its session data permanently? This cannot be undone.'
      )
    )
      return
    await window.atelier.agent.delete(id)
    const remaining = await window.atelier.agent.list()
    setOpen(remaining)
    setAll(await window.atelier.agent.listAll())
    if (activeId === id) setActiveId(remaining[0]?.id ?? null)
  }

  if (error) return <div className="boot boot-error">Failed to start: {error}</div>

  return (
    <div className="app">
      <ConversationBar
        open={open}
        all={all}
        activeId={activeId}
        onSelect={setActiveId}
        onOpen={openConversation}
        onClose={closeConversation}
        onNew={newConversation}
        onRename={renameConversation}
        onClearChat={clearChat}
        onClearPlugins={clearPlugins}
        onImport={startImport}
        onDelete={deleteConversation}
      />
      {usage && usage.windows.length > 0 && (
        <div className="usage-strip">
          <UsageMini windows={usage.windows} />
        </div>
      )}
      {activeId ? (
        <DockviewReact
          className="dockview-theme-abyss dock-root"
          components={components}
          onReady={onReady}
        />
      ) : (
        <div className="boot">No conversation open — pick one from ▾ Previous, or ＋ New.</div>
      )}
      {importing && (
        <ImportModal
          sessions={importing.sessions}
          onPick={doImport}
          onCancel={() => setImporting(null)}
        />
      )}
    </div>
  )
}

function ImportModal({
  sessions,
  onPick,
  onCancel
}: {
  sessions: SessionSummary[]
  onPick: (sessionId: string, title: string) => void
  onCancel: () => void
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Resume an existing Claude session</div>
        <div className="modal-list">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              className="modal-item"
              onClick={() => onPick(s.sessionId, s.summary || s.firstPrompt || 'Imported')}
            >
              <span className="modal-item-title">
                {s.summary || s.firstPrompt || s.sessionId.slice(0, 8)}
              </span>
              <span className="modal-item-date">{new Date(s.lastModified).toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-stop" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/** Account-wide usage meters shown in a thin strip under the conversation bar. */
function UsageMini({ windows }: { windows: UsageWindow[] }) {
  return (
    <div className="usage-mini">
      {windows.slice(0, 2).map((w) => {
        const pct = Math.max(0, Math.min(100, w.utilization))
        const tone = pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'ok'
        return (
          <div
            key={w.key}
            className="usage-mini-row"
            title={
              w.resetsAt
                ? `${w.label}: ${pct.toFixed(0)}% — resets ${resetAbsolute(w.resetsAt)}`
                : `${w.label}: ${pct.toFixed(0)}%`
            }
          >
            <span className="usage-mini-label">{w.label}</span>
            <span className="usage-bar-track">
              <span className={`usage-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
            </span>
            <span className="usage-mini-pct">{pct.toFixed(0)}%</span>
            {w.resetsAt && (
              <span className="usage-mini-reset">resets {resetShort(w.resetsAt)}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function resetShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  let mins = Math.round((d.getTime() - Date.now()) / 60000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 1440) {
    const h = Math.floor(mins / 60)
    mins = mins % 60
    return mins ? `${h}h${mins}m` : `${h}h`
  }
  return `${Math.round(mins / 1440)}d`
}

function resetAbsolute(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function ConversationBar({
  open,
  all,
  activeId,
  onSelect,
  onOpen,
  onClose,
  onNew,
  onRename,
  onClearChat,
  onClearPlugins,
  onImport,
  onDelete
}: {
  open: AgentInstance[]
  all: ConversationSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onClearChat: (id: string) => void
  onClearPlugins: (id: string) => void
  onImport: () => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState(false)
  const active = open.find((c) => c.id === activeId)

  const startRename = (c: AgentInstance) => {
    setEditing(c.id)
    setDraft(c.title)
  }
  const commit = () => {
    if (editing && draft.trim()) onRename(editing, draft.trim())
    setEditing(null)
  }

  return (
    <div className="conversation-bar">
      <div className="conv-dropdown">
        <button
          className="conv-menu-btn"
          onClick={() => setMenu((m) => !m)}
          title="All conversations"
        >
          ☰ Conversations
        </button>
        {menu && (
          <div className="conv-menu" onMouseLeave={() => setMenu(false)}>
            {all.length === 0 && <div className="conv-menu-empty">No conversations</div>}
            {all
              .slice()
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((c) => (
                <div key={c.id} className={`conv-menu-item ${c.id === activeId ? 'active' : ''}`}>
                  <button
                    className="conv-menu-main"
                    title={c.cwd}
                    onClick={() => {
                      setMenu(false)
                      onOpen(c.id)
                    }}
                  >
                    <span className="conv-menu-title">
                      {c.title}
                      {c.open && <span className="conv-menu-open"> •</span>}
                    </span>
                    <span className="conv-menu-folder">{c.cwd}</span>
                  </button>
                  <button
                    className="conv-trash"
                    title="Delete this conversation and its session data"
                    onClick={() => onDelete(c.id)}
                  >
                    🗑
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="conv-tabs">
        {open.map((c) =>
          editing === c.id ? (
            <input
              key={c.id}
              className="conv-rename"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                else if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span key={c.id} className={`conv-tab ${c.id === activeId ? 'active' : ''}`}>
              <button
                className="conv-tab-label"
                onClick={() => onSelect(c.id)}
                onDoubleClick={() => startRename(c)}
                title={`${c.cwd}  (double-click to rename)`}
              >
                {c.title}
              </button>
              <button
                className="conv-close"
                title="Close conversation"
                onClick={() => onClose(c.id)}
              >
                ×
              </button>
            </span>
          )
        )}
        <button className="conv-new" onClick={onNew} title="New conversation in another folder">
          ＋
        </button>
        <button
          className="conv-prev"
          onClick={onImport}
          title="Resume an existing Claude session from a folder"
        >
          ⤓
        </button>
      </div>

      {active && (
        <div className="conv-meta">
          <span className="conv-cwd" title={active.cwd}>
            {active.cwd}
          </span>
          <button
            className="icon-btn"
            title="Reveal folder in file manager"
            onClick={() => void window.atelier.app.openPath(active.cwd)}
          >
            📂
          </button>
          <button
            className="icon-btn"
            title="Clear chat context (fresh session)"
            onClick={() => onClearChat(active.id)}
          >
            Clear chat
          </button>
          <button
            className="icon-btn"
            title="Clear plugin data/state"
            onClick={() => onClearPlugins(active.id)}
          >
            Clear plugins
          </button>
        </div>
      )}
    </div>
  )
}
