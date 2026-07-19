import type { AgentStatus } from '../shared/events.js'

/**
 * TurnLedger — the single source of truth for "is the agent working?".
 *
 * Atelier holds every user message here and releases AT MOST ONE into the SDK at a time;
 * the next is released only after the previous turn settles (result / abort / kill).
 * Sends↔turns are therefore 1:1 by construction, and busyness is a fact this process owns
 * rather than an inference over counters that must be compensated on every failure path
 * (docs/STATUS_LOCKSTEP.md — this replaces `turnsInFlight`).
 *
 * Pure and SDK-free so the status invariant (working ⟺ released ∨ queue non-empty) is
 * unit-testable over arbitrary operation orders.
 */

/** A user turn Atelier has accepted but not yet handed to the SDK. */
export interface QueuedTurn {
  id: string
  text: string
  queuedAt: number
}

/** The single turn currently inside the SDK, awaiting settlement. */
export interface ReleasedTurn extends QueuedTurn {
  releasedAt: number
}

export class TurnLedger {
  private queue: QueuedTurn[] = []
  private current: ReleasedTurn | null = null
  private nextId = 0

  /** Accept a user message into the pending queue (it is NOT yet visible to the SDK). */
  enqueue(text: string): QueuedTurn {
    const turn: QueuedTurn = { id: `t${++this.nextId}`, text, queuedAt: Date.now() }
    this.queue.push(turn)
    return turn
  }

  /** The turn currently inside the SDK, or null when none is in flight. */
  get released(): ReleasedTurn | null {
    return this.current
  }

  /** Number of turns waiting behind the released one. */
  get depth(): number {
    return this.queue.length
  }

  /** The busyness fact `deriveStatus` consumes: a turn is in flight or waiting. */
  get busy(): boolean {
    return this.current !== null || this.queue.length > 0
  }

  /**
   * Hand the next queued turn to the SDK. Returns null (a no-op) while a turn is already
   * in flight or nothing is queued — callers gate on the return value, so double-release
   * is structurally impossible.
   */
  release(): ReleasedTurn | null {
    if (this.current !== null) return null
    const next = this.queue.shift()
    if (!next) return null
    this.current = { ...next, releasedAt: Date.now() }
    return this.current
  }

  /**
   * The in-flight turn ended (result arrived, or it died with its query). Returns the
   * settled turn — null means nothing was in flight, which for a `result` arrival is an
   * invariant breach the caller must log loudly (never swallow it like Math.max did).
   */
  settle(): ReleasedTurn | null {
    const settled = this.current
    this.current = null
    return settled
  }

  /**
   * Drop the whole pipeline (user Stop, rate-limit rejection). Returns what was dropped
   * so callers can report it instead of losing messages silently.
   */
  clear(): { released: ReleasedTurn | null; queued: QueuedTurn[] } {
    const dropped = { released: this.current, queued: this.queue }
    this.current = null
    this.queue = []
    return dropped
  }
}

/** The complete set of facts status derives from. Each has exactly one writer. */
export interface StatusFacts {
  /** The conversation was closed (terminal). */
  closed: boolean
  /** Unrecoverable failure (restart budget exhausted, auth failure); cleared by a new send. */
  wedged: boolean
  /** TurnLedger.busy — a turn is in flight or queued. */
  busy: boolean
}

/**
 * Status is DERIVED, never stored: any consumer can recompute it from the facts at any
 * time, so a missed transition can only ever be stale, not permanently wrong.
 */
export function deriveStatus(f: StatusFacts): AgentStatus {
  if (f.closed) return 'closed'
  if (f.wedged) return 'error'
  return f.busy ? 'working' : 'idle'
}
