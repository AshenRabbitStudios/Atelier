import { Fragment, useState } from 'react'
import type { DiscoveredPlugin, ConversationPluginState } from '@shared/plugins'
import { ICONS } from '../icons'

// Sidebar ordering (DESIGN_SYSTEM.md §5). Plugins arrive from the registry in folder order; the
// rail presents them in these curated, titled groups, with a divider between each. Any plugin not
// listed here (new drops, workspace plugins, broken ones) falls into the trailing catch-all group
// in registry order, so nothing is ever hidden by reordering. Titles show only when expanded —
// the collapsed icon rail keeps the dividers alone.
const RAIL_GROUPS: { title: string; ids: string[] }[] = [
  { title: 'Core', ids: ['terminal', 'browser', 'workspace-explorer'] },
  {
    title: 'Agent Interface',
    ids: ['instructions', 'cognition', 'notifications', 'agent-flow', 'whiteboard']
  }
]
// Everything not named above lands here.
const REST_GROUP_TITLE = 'Utility'

interface RailGroup {
  title: string
  plugins: DiscoveredPlugin[]
}

function groupPlugins(plugins: DiscoveredPlugin[]): RailGroup[] {
  const byId = new Map(plugins.map((p) => [p.id, p]))
  const used = new Set<string>()
  const groups: RailGroup[] = []
  for (const { title, ids } of RAIL_GROUPS) {
    const group = ids.flatMap((id) => {
      const p = byId.get(id)
      if (!p) return []
      used.add(id)
      return [p]
    })
    if (group.length) groups.push({ title, plugins: group })
  }
  const rest = plugins.filter((p) => !used.has(p.id))
  if (rest.length) groups.push({ title: REST_GROUP_TITLE, plugins: rest })
  return groups
}

// Perma-docked left sidebar (DESIGN_SYSTEM.md §5; app chrome, not a Dockview pane). Collapsed =
// a thin icon rail; expanded = the app-wide plugin list. Enablement is per-conversation: loading
// docks a Panel, ejecting removes it. A loaded plugin's icon goes --accent; broken plugins list
// with their error and never crash the app. New plugins appear by dropping a folder in /plugins.
interface Props {
  plugins: DiscoveredPlugin[]
  enabled: Record<string, ConversationPluginState>
  onToggle: (pluginId: string, enabled: boolean) => void
  onReload: (pluginId: string) => void
  /** Whether the Claude chat pane is currently docked. */
  claudeOpen: boolean
  /** Re-open the Claude pane if it was closed (visual-only), else focus it. */
  onShowClaude: () => void
}

// 16px speech-bubble glyph for the Claude pane re-open button.
const CHAT_ICON = 'M2.5 3.5h11v7h-7l-3 2.5v-2.5h-1z'

function PlugIcon({ d, active }: { d?: string; active: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} style={{ display: 'block' }}>
      <path
        d={d ?? ICONS.plugin}
        className="icon"
        style={{ stroke: active ? 'var(--accent)' : 'var(--faint)' }}
      />
    </svg>
  )
}

export function PluginRail({
  plugins,
  enabled,
  onToggle,
  onReload,
  claudeOpen,
  onShowClaude
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const broken = plugins.filter((p) => !p.valid).length
  const groups = groupPlugins(plugins)

  return (
    <div className={`plugin-rail ${open ? 'open' : ''}`}>
      <button
        className={`rail-claude ${claudeOpen ? 'is-open' : ''}`}
        title={claudeOpen ? 'Claude chat — focus' : 'Show Claude chat'}
        onClick={onShowClaude}
      >
        <svg viewBox="0 0 16 16" width={16} height={16} style={{ display: 'block' }}>
          <path
            d={CHAT_ICON}
            className="icon"
            style={{ stroke: claudeOpen ? 'var(--accent)' : 'var(--faint)' }}
          />
        </svg>
      </button>
      <div className="rail-sep" />
      <button
        className="rail-toggle"
        title={open ? 'Collapse plugins' : `Plugins${broken ? ` (${broken} with errors)` : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <PlugIcon active={false} />
      </button>
      <div className="rail-sep" />
      {!open && (
        // Collapsed: a lit/unlit icon per plugin — click to load/eject without expanding; hover
        // shows the name. (Loaded → accent.)
        <div className="rail-icons">
          {groups.map((group, gi) => (
            <Fragment key={group.title}>
              {gi > 0 && <div className="rail-sep" />}
              {group.plugins.map((p) => {
                const on = p.valid && Boolean(enabled[p.id]?.enabled)
                return (
                  <button
                    key={p.id}
                    className={`rail-icon ${on ? 'is-loaded' : ''} ${p.valid ? '' : 'invalid'}`}
                    title={
                      p.valid
                        ? `${p.manifest?.name ?? p.id}${on ? ' — loaded (click to eject)' : ' — click to load'}`
                        : `${p.id}: ${p.error}`
                    }
                    disabled={!p.valid}
                    onClick={() => onToggle(p.id, !on)}
                  >
                    <PlugIcon d={p.manifest?.icon} active={on} />
                  </button>
                )
              })}
            </Fragment>
          ))}
        </div>
      )}
      {open && (
        <div className="rail-list">
          <div className="rail-head">Plugins</div>
          {plugins.length === 0 && (
            <div className="rail-empty">Drop a folder in /plugins to add one.</div>
          )}
          {groups.map((group) => (
            <Fragment key={group.title}>
              <div className="rail-group-head">{group.title}</div>
              {group.plugins.map((p) => {
                const on = p.valid && Boolean(enabled[p.id]?.enabled)
                const desc = p.valid
                  ? p.manifest?.permissions.length
                    ? p.manifest.permissions.join(' · ')
                    : `v${p.manifest?.version}`
                  : p.error
                return (
                  <div
                    key={p.id}
                    className={`rail-item ${on ? 'is-loaded' : ''} ${p.valid ? '' : 'invalid'}`}
                  >
                    <span className="rail-item-icon">
                      <PlugIcon d={p.manifest?.icon} active={on} />
                    </span>
                    <div className="rail-item-text">
                      <span className="rail-item-name" title={p.dir}>
                        {p.manifest?.name ?? p.id}
                        {p.scope === 'workspace' && (
                          <span
                            className="rail-item-scope"
                            title="Lives in this project's .atelier/plugins"
                          >
                            {' '}
                            workspace
                          </span>
                        )}
                      </span>
                      <span className="rail-item-desc">{desc}</span>
                    </div>
                    {p.valid ? (
                      <div className="rail-item-actions">
                        {on && (
                          <button
                            className="rail-act"
                            title="Reload"
                            onClick={() => onReload(p.id)}
                          >
                            ⟳
                          </button>
                        )}
                        <button
                          className="rail-act"
                          title={on ? 'Eject' : 'Load'}
                          onClick={() => onToggle(p.id, !on)}
                        >
                          {on ? '×' : '+'}
                        </button>
                      </div>
                    ) : (
                      <span className="rail-error-badge">error</span>
                    )}
                  </div>
                )
              })}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
