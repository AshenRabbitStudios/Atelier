import { useState } from 'react'
import type { DiscoveredPlugin, ConversationPluginState } from '@shared/plugins'

// Perma-docked left rail (app chrome, NOT a Dockview pane). Collapsed = a thin icon strip;
// expanded = the app-wide plugin list. Enablement is per-conversation: the toggle reflects/sets
// whether THIS conversation shows the plugin. Broken plugins list with their error, never crash.
interface Props {
  plugins: DiscoveredPlugin[]
  enabled: Record<string, ConversationPluginState>
  onToggle: (pluginId: string, enabled: boolean) => void
  onReload: (pluginId: string) => void
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
        🧩
      </button>
      {open && (
        <div className="rail-list">
          <div className="rail-head">Plugins</div>
          {plugins.length === 0 && <div className="rail-empty">Nothing in /plugins yet.</div>}
          {plugins.map((p) => (
            <div key={p.id} className={`rail-item ${p.valid ? '' : 'invalid'}`}>
              <div className="rail-item-row">
                <span className="rail-item-name" title={p.dir}>
                  {p.manifest?.name ?? p.id}
                </span>
                {p.valid ? (
                  <label className="rail-switch" title="Enable for this conversation">
                    <input
                      type="checkbox"
                      checked={Boolean(enabled[p.id]?.enabled)}
                      onChange={(e) => onToggle(p.id, e.target.checked)}
                    />
                  </label>
                ) : (
                  <span className="rail-error-badge">error</span>
                )}
              </div>
              {p.valid && p.manifest?.permissions.length ? (
                <div className="rail-item-perms">{p.manifest.permissions.join(' · ')}</div>
              ) : null}
              {!p.valid && <div className="rail-item-error">{p.error}</div>}
              {p.valid && enabled[p.id]?.enabled && (
                <button className="rail-reload" onClick={() => onReload(p.id)}>
                  reload
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
