import type { UsageWindow } from '@shared/events'

// Subscription usage in the top bar (LOCKED DECISION LD-2). Account-wide, always visible: two
// windows (5-hour + weekly), each with a bar that ramps --ok → --warn (≥70%) → --err (≥90%),
// a numeric %, and time-to-reset. Data is the existing agent.usage snapshot.

/** color ramp — the ONE place the threshold logic lives */
function ramp(util: number): string {
  if (util >= 90) return 'var(--err)'
  if (util >= 70) return 'var(--warn)'
  return 'var(--ok)'
}

/** "2h 40m", "4d 6h", "now" */
function untilReset(iso?: string): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  let m = Math.round(ms / 60000)
  if (m <= 0) return 'now'
  if (m < 60) return `${m}m`
  if (m < 1440) {
    const h = Math.floor(m / 60)
    m %= 60
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return h ? `${d}d ${h}h` : `${d}d`
}

export function UsageMeters({ windows }: { windows: UsageWindow[] }): React.JSX.Element {
  return (
    <div className="usage-meters">
      {windows.slice(0, 2).map((w) => {
        const pct = Math.max(0, Math.min(100, Math.round(w.utilization)))
        const color = ramp(pct)
        const reset = untilReset(w.resetsAt)
        return (
          <div
            key={w.key}
            className="usage-meter"
            title={`${w.label}: ${pct}%${reset ? ` — resets in ${reset}` : ''}`}
          >
            <span className="um-label">{w.label}</span>
            <span className="um-track">
              <span className="um-fill" style={{ width: `${pct}%`, background: color }} />
            </span>
            <span className="um-pct" style={{ color }}>
              {pct}%
            </span>
            {reset && <span className="um-reset">· {reset}</span>}
          </div>
        )
      })}
    </div>
  )
}
