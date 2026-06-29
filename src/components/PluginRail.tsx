import { useState } from 'react'
import type { DiscoveredPlugin, ConversationPluginState } from '@shared/plugins'
import { ICONS } from '../icons'

// Perma-docked left sidebar (DESIGN_SYSTEM.md §5; app chrome, not a Dockview pane). Collapsed =
// a thin icon rail; expanded = the app-wide plugin list. Enablement is per-conversation: loading
// docks a Panel, ejecting removes it. A loaded plugin's icon goes --accent; broken plugins list
// with their error and never crash the app. New plugins appear by dropping a folder in /plugins.
interface Props {
  plugins: DiscoveredPlugin[]
  enabled: Record<string, ConversationPluginState>
  onToggle: (pluginId: string, enabled: boolean) => void
  onReload: (pluginId: string) => void
}

function PlugIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} style={{ display: 'block' }}>
      <path
        d={ICONS.plugin}
        className="icon"
        style={{ stroke: active ? 'var(--accent)' : 'var(--faint)' }}
      />
    </svg>
  )
}

export function PluginRail({ plugins, enabled, onToggle, onReload }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const broken = plugins.filter((p) => !p.valid).length

  return (
    <div className={`plugin-rail ${open ? 'open' : ''}`}>
      <button
        className="rail-toggle"
        title={`Plugins${broken ? ` (${broken} with errors)` : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <PlugIcon active={false} />
      </button>
      {open && (
        <div className="rail-list">
          <div className="rail-head">Plugins</div>
          {plugins.length === 0 && (
            <div className="rail-empty">Drop a folder in /plugins to add one.</div>
          )}
          {plugins.map((p) => {
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
                  <PlugIcon active={on} />
                </span>
                <div className="rail-item-text">
                  <span className="rail-item-name" title={p.dir}>
                    {p.manifest?.name ?? p.id}
                  </span>
                  <span className="rail-item-desc">{desc}</span>
                </div>
                {p.valid ? (
                  <div className="rail-item-actions">
                    {on && (
                      <button className="rail-act" title="Reload" onClick={() => onReload(p.id)}>
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
        </div>
      )}
    </div>
  )
}
