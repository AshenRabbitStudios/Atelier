import type { NotifyResult } from '../shared/events.js'

// A4 — host-side OS attention for plugin panes (permission `os:notify`): Electron notifications with
// per-plugin `tag` coalescing and a host-side rate cap, plus taskbar flash / badge and window-focus
// queries. Every primitive (create a notification, focus the window, flash, badge) is injected so
// this stays Electron-free and unit-testable; main.ts supplies the real ones. Denial/failure never
// throws across the relay — the caller gets `{ error }` (notify) or a silent no-op (best-effort os
// verbs). Rate cap: ≤1 notification / plugin / RATE_WINDOW_MS; excess is dropped with `{ error }`
// (a same-tag replacement is exempt — it coalesces rather than adds).

export const RATE_WINDOW_MS = 3000

/** One live OS notification we can close (for tag coalescing). */
export interface HostNotification {
  close(): void
}

export interface NotifyDeps {
  /** Create + show a notification; `onClick` fires when the user clicks it. Returns a closable handle. */
  show(
    opts: { title: string; body: string; silent: boolean },
    onClick: () => void
  ): HostNotification
  /** Bring the Atelier window to the foreground (accepts Windows foreground-lock limits). */
  focusWindow(): void
  flashFrame(on: boolean): void
  setBadgeCount(count: number): void
  isWindowFocused(): boolean
  /** Notify the owning pane that one of its notifications was clicked. */
  emitClick(pluginId: string, notificationId: string): void
  now?: () => number
}

export class OsNotifier {
  // Live notifications keyed by `${pluginId}\0${tag}` so a same-tag replacement closes the prior one.
  private byTag = new Map<string, HostNotification>()
  // Last emit time per plugin, for the rate cap.
  private lastEmit = new Map<string, number>()
  private seq = 0
  private now: () => number

  constructor(private deps: NotifyDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  notify(
    pluginId: string,
    n: { title: string; body: string; sound?: boolean; tag?: string }
  ): NotifyResult {
    const tagKey = n.tag ? `${pluginId}\0${n.tag}` : null
    const isReplacement = !!(tagKey && this.byTag.has(tagKey))
    // Rate cap — a same-tag replacement is exempt (it coalesces onto an existing slot).
    if (!isReplacement) {
      const last = this.lastEmit.get(pluginId) ?? 0
      if (this.now() - last < RATE_WINDOW_MS) {
        return { error: 'notification rate limit exceeded' }
      }
    }
    // Coalesce: close the prior same-tag notification before showing the new one.
    if (tagKey) this.byTag.get(tagKey)?.close()

    const id = `${pluginId}:notif:${++this.seq}`
    let handle: HostNotification
    try {
      handle = this.deps.show({ title: n.title, body: n.body, silent: !n.sound }, () => {
        this.deps.focusWindow()
        this.deps.emitClick(pluginId, id)
        if (tagKey) this.byTag.delete(tagKey)
      })
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    this.lastEmit.set(pluginId, this.now())
    if (tagKey) this.byTag.set(tagKey, handle)
    return { id }
  }

  flashFrame(on: boolean): void {
    try {
      this.deps.flashFrame(on)
    } catch {
      /* best-effort */
    }
  }

  setBadgeCount(count: number): void {
    try {
      this.deps.setBadgeCount(Math.max(0, Math.floor(count)))
    } catch {
      /* best-effort */
    }
  }

  isWindowFocused(): boolean {
    try {
      return this.deps.isWindowFocused()
    } catch {
      return false
    }
  }
}
