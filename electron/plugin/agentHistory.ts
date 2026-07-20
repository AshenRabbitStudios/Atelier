import type { AgentEvent } from '../shared/events.js'

// A5 — a bounded, in-memory, per-conversation ring of normalized AgentEvents. Main is the single
// source of truth for the agent trace (it already emits every event to the renderer); this records
// the last N so a pane that mounts mid-conversation can backfill (agent-flow, timeline restore, heat
// backfill all hang off it — HOST-ADDENDUM A5). In-memory is acceptable for v1; persistence across
// restart is future work. Keyed by `instanceId` (== conversationId).

export const HISTORY_CAP = 1000
export const DEFAULT_LIMIT = 200

export class AgentHistoryRing {
  private rings = new Map<string, AgentEvent[]>()

  /** Record one event (called from the same place main pushes events to the renderer). */
  record(e: AgentEvent): void {
    const id = e.instanceId
    if (!id) return
    let ring = this.rings.get(id)
    if (!ring) {
      ring = []
      this.rings.set(id, ring)
    }
    ring.push(e)
    if (ring.length > HISTORY_CAP) ring.splice(0, ring.length - HISTORY_CAP)
  }

  /** Oldest→newest slice of the last `limit` events (default 200, max 1000). */
  get(instanceId: string, limit = DEFAULT_LIMIT): AgentEvent[] {
    const ring = this.rings.get(instanceId) ?? []
    const n = Math.max(1, Math.min(HISTORY_CAP, limit))
    return n >= ring.length ? ring.slice() : ring.slice(ring.length - n)
  }

  /** Drop a conversation's ring (on delete / clear-chat) so it can't leak across a reset. */
  clear(instanceId: string): void {
    this.rings.delete(instanceId)
  }
}
