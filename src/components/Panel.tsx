import type { ReactNode } from 'react'

// The universal docked surface (DESIGN_SYSTEM.md §4). EVERY docked kind — the chat pane, a
// metrics pane, a terminal, a plugin nobody has written yet — is this same shell: rounded
// surface, a --tab-h header (tab strip + actions), a scrolling body. The chrome never
// special-cases a kind; the kind only supplies the body. That is what keeps the workspace
// content-unbounded. A plugin supplies ONLY id/title/icon/body and never styles the chrome.
//
// Wired in App.tsx: every Dockview `components` entry returns a <Panel>. Dockview's own tab
// bar is suppressed via CSS so this header is the single source of chrome.
export interface PanelTab {
  id: string
  title: string
  /** single-path 16px line-icon `d` string (icons.ts / DESIGN_SYSTEM.md §6) */
  icon?: string
}
export interface PanelAction {
  id: string
  title: string
  icon: string
  onClick: () => void
}
export interface PanelProps {
  tabs: PanelTab[]
  activeTabId?: string
  onSelectTab?: (id: string) => void
  actions?: PanelAction[]
  children: ReactNode
}

function Icon({ d, size = 15 }: { d: string; size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} style={{ display: 'block' }}>
      <path d={d} className="icon" />
    </svg>
  )
}

export function Panel({
  tabs,
  activeTabId,
  onSelectTab,
  actions = [],
  children
}: PanelProps): React.JSX.Element {
  const active = activeTabId ?? tabs[0]?.id
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab ${t.id === active ? 'is-selected' : ''}`}
              onClick={() => onSelectTab?.(t.id)}
            >
              {t.icon && <Icon d={t.icon} size={13} />}
              {t.title}
            </button>
          ))}
        </div>
        <div className="panel-actions">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className="panel-action"
              title={a.title}
              onClick={a.onClick}
            >
              <Icon d={a.icon} size={13} />
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  )
}
